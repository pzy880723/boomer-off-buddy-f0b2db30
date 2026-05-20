import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { generateEpc, PRICE_TIERS } from "./inventory.helpers";

/** 包裹搜索（手机端通用） */
export const searchParcels = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z
      .object({
        q: z.string().trim().max(200).optional(),
        limit: z.number().min(1).max(50).default(30),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    let q = supabaseAdmin
      .from("japan_parcels")
      .select(
        "id, source_order_no, tracking_no, status, item_title, item_title_cn, item_image_url, intl_pay_at, received_at, grand_total_cny, is_problem, created_at",
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.q) {
      const s = `%${data.q}%`;
      q = q.or(
        `item_title.ilike.${s},item_title_cn.ilike.${s},source_order_no.ilike.${s},tracking_no.ilike.${s},seller.ilike.${s}`,
      );
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
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
        operator: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { data: cur } = await supabaseAdmin
      .from("japan_parcels")
      .select("status_timeline")
      .eq("id", data.id)
      .single();
    const timeline = Array.isArray(cur?.status_timeline) ? [...cur.status_timeline] : [];
    timeline.push({
      step: "delivered",
      at: new Date().toISOString(),
      operator: data.operator ?? null,
      photo_url: data.photo_url ?? null,
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
        operator: z.string().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
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
      photo_url: data.photo_url ?? null,
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

/** 待分拣（已签收）的包裹清单 */
export const listSortQueue = createServerFn({ method: "GET" }).handler(async () => {
  const { data, error } = await supabaseAdmin
    .from("japan_parcels")
    .select(
      "id, source_order_no, tracking_no, item_title, item_title_cn, item_image_url, received_at, grand_total_cny, japan_parcel_items(id)",
    )
    .is("deleted_at", null)
    .eq("status", "delivered")
    .order("received_at", { ascending: false })
    .limit(60);
  if (error) throw new Error(error.message);
  return { rows: data ?? [] };
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
    // 1. 找/建 SKU：按 (category, price_tier, name) 唯一
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

    // 2. 生成一条标签批次（即"待打印"），关联回子商品
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

/** 取某个包裹的分拣进度（每条子商品对应的标签批次） */
export const getSortDetail = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z.object({ parcel_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: parcel, error: pe } = await supabaseAdmin
      .from("japan_parcels")
      .select("id, source_order_no, tracking_no, item_title_cn, item_title, status, received_at")
      .eq("id", data.parcel_id)
      .single();
    if (pe) throw new Error(pe.message);
    const { data: items } = await supabaseAdmin
      .from("japan_parcel_items")
      .select(
        "id, item_title, item_title_cn, item_image_url, unit_price_jpy, item_total_cny, quantity, weight_g, pack_pieces, tariff_category, position",
      )
      .eq("parent_id", data.parcel_id)
      .order("position", { ascending: true });
    const itemIds = (items ?? []).map((i) => i.id);
    let labels: Array<{ id: string; sku_id: string; qty: number; status: string; parcel_item_id: string | null; printed_at: string }> = [];
    if (itemIds.length) {
      const { data: lb } = await supabaseAdmin
        .from("inv_label_batches")
        .select("id, sku_id, qty, status, parcel_item_id, printed_at, inv_skus(id, name, epc, category, price_tier, kind)")
        .in("parcel_item_id", itemIds);
      labels = (lb ?? []) as never;
    }
    return { parcel, items: items ?? [], labels };
  });

/** 标记包裹整体完成分拣 */
export const markParcelSorted = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid(), operator: z.string().nullable().optional() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: cur } = await supabaseAdmin
      .from("japan_parcels")
      .select("status_timeline")
      .eq("id", data.id)
      .single();
    const tl = Array.isArray(cur?.status_timeline) ? [...cur.status_timeline] : [];
    tl.push({ step: "sorted", at: new Date().toISOString(), operator: data.operator ?? null });
    const { error } = await supabaseAdmin
      .from("japan_parcels")
      .update({ status: "completed", status_timeline: tl })
      .eq("id", data.id);
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
