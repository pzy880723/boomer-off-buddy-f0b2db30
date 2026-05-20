import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { generateEpc, PRICE_TIERS } from "./inventory.helpers";

const PENDING_STATUSES = ["purchased", "at_jp_warehouse", "shipping_intl"] as const;
const RECEIVED_STATUSES = ["delivered", "completed"] as const;

/** 包裹搜索（手机端通用） */
export const searchParcels = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z
      .object({
        q: z.string().trim().max(200).optional(),
        bucket: z.enum(["pending", "received", "all"]).default("all"),
        limit: z.number().min(1).max(50).default(30),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const orderCol = data.bucket === "received" ? "received_at" : "created_at";
    let q = supabaseAdmin
      .from("japan_parcels")
      .select(
        "id, source_order_no, tracking_no, status, item_title, item_title_cn, item_image_url, intl_pay_at, received_at, grand_total_cny, is_problem, created_at, japan_parcel_items(id, item_title, item_title_cn, position)",
      )
      .is("deleted_at", null)
      .order(orderCol, { ascending: false, nullsFirst: false })
      .limit(data.limit);
    if (data.bucket === "pending") {
      q = q.in("status", PENDING_STATUSES as unknown as string[]);
    } else if (data.bucket === "received") {
      q = q.in("status", RECEIVED_STATUSES as unknown as string[]);
    }
    if (data.q) {
      const s = `%${data.q}%`;
      q = q.or(
        `item_title.ilike.${s},item_title_cn.ilike.${s},source_order_no.ilike.${s},tracking_no.ilike.${s},seller.ilike.${s}`,
      );
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const mapped = (rows ?? []).map((r) => {
      const children = ((r as { japan_parcel_items?: Array<{ item_title: string | null; item_title_cn: string | null; position: number | null }> }).japan_parcel_items ?? [])
        .slice()
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const first = children[0];
      const firstItemName = first
        ? (first.item_title_cn || first.item_title || "")
        : (r.item_title_cn || r.item_title || "");
      return {
        ...r,
        japan_parcel_items: undefined,
        first_item_name: firstItemName,
        item_count: children.length,
      };
    });
    return { rows: mapped };
  });

/** 待签收 / 待分拣计数（首页用） */
export const getMobileCounts = createServerFn({ method: "GET" }).handler(async () => {
  const [pendingReceive, pendingSort] = await Promise.all([
    supabaseAdmin
      .from("japan_parcels")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null)
      .in("status", ["shipping_intl", "purchased", "at_jp_warehouse"]),
    supabaseAdmin
      .from("japan_parcels")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null)
      .eq("status", "delivered"),
  ]);
  return {
    pendingReceive: pendingReceive.count ?? 0,
    pendingSort: pendingSort.count ?? 0,
  };
});

/** 一键签收 + 写时间线 */
export const markParcelDelivered = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        photo_url: z.string().url().nullable().optional(),
        photo_urls: z.array(z.string().url()).max(9).optional(),
        operator: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const urls = data.photo_urls && data.photo_urls.length > 0
      ? data.photo_urls
      : (data.photo_url ? [data.photo_url] : []);
    const { data: cur } = await supabaseAdmin
      .from("japan_parcels")
      .select("status_timeline, tracking_no, source_order_no, seller")
      .eq("id", data.id)
      .single();
    const timeline = Array.isArray(cur?.status_timeline) ? [...cur.status_timeline] : [];
    timeline.push({
      step: "delivered",
      at: new Date().toISOString(),
      operator: data.operator ?? null,
      photo_url: urls[0] ?? null,
      photo_urls: urls,
      note: data.note ?? null,
    });
    const { error } = await supabaseAdmin
      .from("japan_parcels")
      .update({
        status: "delivered",
        received_at: new Date().toISOString(),
        status_timeline: timeline,
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);

    // 副作用：把这个包裹的每个子商品落地成「待分拣库存」一条
    const { data: items } = await supabaseAdmin
      .from("japan_parcel_items")
      .select("id, item_title, item_title_cn, item_image_url")
      .eq("parent_id", data.id);
    if (items && items.length > 0) {
      const sourceLabel = [cur?.tracking_no || cur?.source_order_no, cur?.seller]
        .filter(Boolean)
        .join(" · ") || null;
      const receivedAt = new Date().toISOString();
      const rows = items.map((it) => ({
        parcel_id: data.id,
        parcel_item_id: it.id,
        title: it.item_title_cn || it.item_title || "(未命名)",
        image_url: it.item_image_url,
        source_label: sourceLabel,
        status: "pending",
        received_at: receivedAt,
      }));
      await supabaseAdmin
        .from("pending_sort_items")
        .upsert(rows as never, { onConflict: "parcel_item_id", ignoreDuplicates: true });
    }

    return { ok: true };
  });

/** 异常标记 + 时间线 */
export const markParcelProblem = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        note: z.string().min(1).max(500),
        photo_url: z.string().url().nullable().optional(),
        photo_urls: z.array(z.string().url()).max(9).optional(),
        operator: z.string().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const urls = data.photo_urls && data.photo_urls.length > 0
      ? data.photo_urls
      : (data.photo_url ? [data.photo_url] : []);
    const { data: cur } = await supabaseAdmin
      .from("japan_parcels")
      .select("status_timeline, notes")
      .eq("id", data.id)
      .single();
    const timeline = Array.isArray(cur?.status_timeline) ? [...cur.status_timeline] : [];
    timeline.push({
      step: "problem",
      at: new Date().toISOString(),
      operator: data.operator ?? null,
      photo_url: urls[0] ?? null,
      photo_urls: urls,
      note: data.note,
    });
    const newNotes = [cur?.notes, `[异常] ${data.note}`].filter(Boolean).join("\n");
    const { error } = await supabaseAdmin
      .from("japan_parcels")
      .update({ is_problem: true, status_timeline: timeline, notes: newNotes })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });


/** 待分拣库存（袋子）列表 */
export const listPendingSortItems = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z
      .object({
        status: z.enum(["pending", "sorted", "discarded"]).default("pending"),
        q: z.string().trim().max(200).optional(),
        limit: z.number().min(1).max(200).default(100),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    let q = supabaseAdmin
      .from("pending_sort_items")
      .select("id, title, image_url, source_label, status, received_at, sorted_at, parcel_id, parcel_item_id")
      .eq("status", data.status)
      .order("received_at", { ascending: false })
      .limit(data.limit);
    if (data.q) {
      const s = `%${data.q}%`;
      q = q.or(`title.ilike.${s},source_label.ilike.${s}`);
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });

/** 取单个袋子 + 已生成的标签批次 */
export const getPendingSortItem = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: row, error } = await supabaseAdmin
      .from("pending_sort_items")
      .select("*")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    const { data: labels } = await supabaseAdmin
      .from("inv_label_batches")
      .select("id, qty, status, printed_at, sku_id, inv_skus(id, name, epc, category, price_tier, kind)")
      .eq("parcel_item_id", row.parcel_item_id)
      .order("printed_at", { ascending: false });
    return { row, labels: labels ?? [] };
  });

/** 标记袋子分拣完成 / 作废 */
export const markPendingSortItemDone = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        action: z.enum(["sorted", "discarded"]).default("sorted"),
        notes: z.string().max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const patch: Record<string, unknown> = { status: data.action, sorted_at: new Date().toISOString() };
    if (data.notes != null) patch.notes = data.notes;
    const { error } = await supabaseAdmin
      .from("pending_sort_items")
      .update(patch)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** 分拣：把一条子商品转成 SKU（按类目+档位+品名查重复用），并生成一条标签批次 */
const SortSkuSchema = z.object({
  parcel_item_id: z.string().uuid(),
  category: z.string().min(1),
  price_tier: z.number().positive(),
  name: z.string().min(1).max(120),
  kind: z.enum(["single", "pack"]).default("single"),
  pack_pieces: z.number().int().positive().nullable().optional(),
  image_url: z.string().nullable().optional(),
  weight_g: z.number().nullable().optional(),
  qty: z.number().int().min(1).max(500).default(1),
  operator: z.string().nullable().optional(),
});

export const sortItemToSku = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => SortSkuSchema.parse(input))
  .handler(async ({ data }) => {
    const { data: existing } = await supabaseAdmin
      .from("inv_skus")
      .select("id, epc, name, category, price_tier, kind")
      .eq("category", data.category)
      .eq("price_tier", data.price_tier)
      .eq("name", data.name)
      .limit(1)
      .maybeSingle();

    let sku = existing;
    if (!sku) {
      const epc = generateEpc(data.category, data.price_tier);
      const { data: created, error: ce } = await supabaseAdmin
        .from("inv_skus")
        .insert({
          category: data.category,
          price_tier: data.price_tier,
          name: data.name,
          kind: data.kind,
          pack_pieces: data.kind === "pack" ? data.pack_pieces ?? null : null,
          image_url: data.image_url ?? null,
          weight_g: data.weight_g ?? null,
          epc,
          status: "active",
        } as never)
        .select("id, epc, name, category, price_tier, kind")
        .single();
      if (ce) throw new Error(ce.message);
      sku = created;
    }

    const { data: batch, error: be } = await supabaseAdmin
      .from("inv_label_batches")
      .insert({
        sku_id: sku.id,
        qty: data.qty,
        operator: data.operator ?? null,
        status: "printed",
        parcel_item_id: data.parcel_item_id,
      } as never)
      .select("id, qty, status")
      .single();
    if (be) throw new Error(be.message);

    return { sku, batch };
  });

/** 撤销分拣（删除关联标签） */
export const undoSortLabel = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ batch_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { error } = await supabaseAdmin
      .from("inv_label_batches")
      .delete()
      .eq("id", data.batch_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** 拍照识图（MVP A：扫最近候选喂 Gemini 多模态对比） */
export const photoSearch = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        image_base64: z.string().min(100),
        mime: z.string().default("image/webp"),
        limit: z.number().min(1).max(10).default(5),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { data: candidates } = await supabaseAdmin
      .from("japan_parcel_items")
      .select(
        "id, parent_id, item_title, item_title_cn, item_image_url, item_total_cny, unit_price_jpy, quantity",
      )
      .not("item_image_url", "is", null)
      .order("created_at", { ascending: false })
      .limit(200);

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY missing");
    const rows = candidates ?? [];

    if (rows.length === 0) return { matches: [] };

    // 单次调用：让模型从候选 ID 中挑 Top N
    const list = rows
      .map(
        (r, i) =>
          `${i + 1}. id=${r.id} | ${r.item_title_cn || r.item_title || ""} | 图: ${r.item_image_url}`,
      )
      .join("\n");
    const prompt = `下面是用户上传的查询图。请从候选商品清单中找出与查询图最相似的最多 ${data.limit} 件，按相似度从高到低返回。\n只回复严格 JSON，形如 {"matches":[{"id":"uuid","score":0-1,"reason":"短理由"}]}\n候选商品（共 ${rows.length} 件）：\n${list}`;

    const upstream = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:${data.mime};base64,${data.image_base64}` },
              },
            ],
          },
        ],
      }),
    });
    if (!upstream.ok) {
      const t = await upstream.text();
      throw new Error(`AI gateway ${upstream.status}: ${t.slice(0, 200)}`);
    }
    const body = (await upstream.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = body.choices?.[0]?.message?.content ?? "{}";
    let parsed: { matches?: Array<{ id: string; score: number; reason?: string }> } = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { matches: [] };
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    const matches = (parsed.matches ?? [])
      .filter((m) => byId.has(m.id))
      .slice(0, data.limit)
      .map((m) => {
        const r = byId.get(m.id)!;
        return {
          id: r.id,
          parcel_id: r.parent_id,
          item_title_cn: r.item_title_cn,
          item_title: r.item_title,
          item_image_url: r.item_image_url,
          item_total_cny: r.item_total_cny,
          unit_price_jpy: r.unit_price_jpy,
          quantity: r.quantity,
          score: m.score,
          reason: m.reason ?? null,
        };
      });
    return { matches };
  });

/** 手机端按 EPC 查 SKU + 库存 + 来源 */
export const traceByEpc = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z.object({ epc: z.string().min(3).max(64) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: sku } = await supabaseAdmin
      .from("inv_skus")
      .select("*")
      .eq("epc", data.epc.trim())
      .maybeSingle();
    if (!sku) return { sku: null, batches: [], lines: [] };
    const { data: batches } = await supabaseAdmin
      .from("inv_label_batches")
      .select("id, qty, printed_at, status, parcel_item_id")
      .eq("sku_id", sku.id)
      .order("printed_at", { ascending: false })
      .limit(20);
    const { data: lines } = await supabaseAdmin
      .from("inv_inbound_lines")
      .select("id, qty, unit_price, subtotal, created_at, order_id")
      .eq("sku_id", sku.id)
      .order("created_at", { ascending: false })
      .limit(20);
    return { sku, batches: batches ?? [], lines: lines ?? [] };
  });

export const MOBILE_PRICE_TIERS = PRICE_TIERS;
