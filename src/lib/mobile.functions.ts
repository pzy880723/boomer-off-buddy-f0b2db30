import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PRICE_TIERS } from "./inventory.helpers";
import { computeParcelItemLanded } from "./japan-parcel.helpers";

const PENDING_STATUSES = ["purchased", "at_jp_warehouse", "shipping_intl"] as const;
const RECEIVED_STATUSES = ["delivered", "completed"] as const;

/** 包裹搜索（手机端通用） */
export const searchParcels = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z
      .object({
        q: z.string().trim().max(200).optional(),
        bucket: z.enum(["pending", "received", "all"]).default("all"),
        mode: z.enum(["parcel", "item"]).default("parcel"),
        limit: z.number().min(1).max(50).default(30),
        offset: z.number().min(0).default(0),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const from = data.offset;
    const to = data.offset + data.limit - 1;

    if (data.mode === "item") {
      let q = supabaseAdmin
        .from("japan_parcel_items")
        .select(
          "id, parent_id, sub_order_no, merchant_order_no, source_platform, condition, addon_service, item_title, item_title_cn, item_image_url, unit_price_jpy, quantity, item_total_jpy, item_total_cny, weight_g, exchange_rate, service_fee_jpy, domestic_freight_jpy, freight_diff_jpy, pay_method, pay_at, tariff_category, tariff_rate, notes, arrival_photo_urls, position, system_code, created_by, created_at, pack_pieces, pack_pieces_source, pack_unit_note, japan_parcels!inner(id, source_order_no, tracking_no, status, received_at, is_problem, deleted_at, intl_pay_at, created_at, system_code, created_by)",
        )
        .is("japan_parcels.deleted_at", null)
        .range(from, to);
      if (data.bucket === "pending") {
        q = q.in("japan_parcels.status", PENDING_STATUSES as unknown as string[]);
      } else if (data.bucket === "received") {
        q = q.in("japan_parcels.status", RECEIVED_STATUSES as unknown as string[]);
      }
      if (data.q) {
        const s = `%${data.q}%`;
        q = q.or(`item_title.ilike.${s},item_title_cn.ilike.${s},sub_order_no.ilike.${s},system_code.ilike.${s}`);
      }
      q = q
        .order("pay_at", { ascending: false, nullsFirst: false })
        .order("created_at", { referencedTable: "japan_parcels", ascending: false, nullsFirst: false })
        .order("position", { ascending: true });
      const { data: rows, error } = await q;
      if (error) throw new Error(error.message);
      const items = (rows ?? []).map((r) => {
        const p = (r as { japan_parcels?: { id: string; source_order_no: string | null; tracking_no: string | null; status: string; received_at: string | null; is_problem: boolean; intl_pay_at: string | null; created_at: string; system_code: string | null; created_by: string | null } }).japan_parcels;
        return {
          id: r.id,
          parcel_id: r.parent_id,
          parent_id: r.parent_id,
          sub_order_no: r.sub_order_no,
          merchant_order_no: r.merchant_order_no,
          source_platform: r.source_platform,
          condition: r.condition,
          addon_service: r.addon_service,
          item_title: r.item_title,
          item_title_cn: r.item_title_cn,
          item_image_url: r.item_image_url,
          unit_price_jpy: r.unit_price_jpy,
          quantity: r.quantity,
          item_total_jpy: r.item_total_jpy,
          item_total_cny: r.item_total_cny,
          weight_g: r.weight_g,
          exchange_rate: r.exchange_rate,
          service_fee_jpy: r.service_fee_jpy,
          domestic_freight_jpy: r.domestic_freight_jpy,
          freight_diff_jpy: r.freight_diff_jpy,
          pay_method: r.pay_method,
          pay_at: r.pay_at,
          tariff_category: r.tariff_category,
          tariff_rate: r.tariff_rate,
          notes: r.notes,
          arrival_photo_urls: r.arrival_photo_urls,
          pack_pieces: (r as { pack_pieces: number | null }).pack_pieces,
          pack_pieces_source: (r as { pack_pieces_source: string | null }).pack_pieces_source,
          pack_unit_note: (r as { pack_unit_note: string | null }).pack_unit_note,
          system_code: (r as { system_code: string | null }).system_code,
          created_by: (r as { created_by: string | null }).created_by,
          created_at: (r as { created_at: string }).created_at,
          source_order_no: p?.source_order_no ?? null,
          tracking_no: p?.tracking_no ?? null,
          status: p?.status ?? null,
          received_at: p?.received_at ?? null,
          is_problem: p?.is_problem ?? false,
          intl_pay_at: p?.intl_pay_at ?? null,
          parcel_system_code: p?.system_code ?? null,
          parcel_created_by: p?.created_by ?? null,
        };
      });

      // 为列表项补 landed_cny（按重量分摊国际运费 + 关税）
      const parentIds = Array.from(new Set(items.map((i) => i.parent_id).filter(Boolean) as string[]));
      if (parentIds.length > 0) {
        const [parcelsRes, siblingsRes] = await Promise.all([
          supabaseAdmin
            .from("japan_parcels")
            .select("id, intl_total_jpy, intl_exchange_rate")
            .in("id", parentIds),
          supabaseAdmin
            .from("japan_parcel_items")
            .select("id, parent_id, item_total_jpy, unit_price_jpy, quantity, weight_g, tariff_rate")
            .in("parent_id", parentIds),
        ]);
        const parcelMap = new Map<string, { intl_total_jpy: number | null; intl_exchange_rate: number | null }>();
        (parcelsRes.data ?? []).forEach((p) => parcelMap.set(p.id, { intl_total_jpy: p.intl_total_jpy ?? null, intl_exchange_rate: p.intl_exchange_rate ?? null }));
        const siblingsByParent = new Map<string, Array<{ id: string; item_total_jpy: number | null; unit_price_jpy: number | null; quantity: number | null; weight_g: number | null; tariff_rate: number | null }>>();
        (siblingsRes.data ?? []).forEach((s) => {
          const k = s.parent_id as string;
          const arr = siblingsByParent.get(k) ?? [];
          arr.push(s);
          siblingsByParent.set(k, arr);
        });
        const landedById = new Map<string, number | null>();
        for (const pid of parentIds) {
          const parcel = parcelMap.get(pid);
          const sibs = siblingsByParent.get(pid) ?? [];
          if (!parcel || sibs.length === 0) continue;
          const m = computeParcelItemLanded(parcel, sibs);
          m.forEach((v, k) => landedById.set(k, v.landedCny));
        }
        items.forEach((it) => {
          (it as { landed_cny?: number | null }).landed_cny = landedById.get(it.id) ?? null;
        });
      }

      return { mode: "item" as const, items, rows: [] as never[], hasMore: items.length === data.limit };
    }


    let q = supabaseAdmin
      .from("japan_parcels")
      .select(
        "id, source_order_no, tracking_no, status, item_title, item_title_cn, item_image_url, intl_pay_at, received_at, grand_total_cny, is_problem, created_at, system_code, created_by, japan_parcel_items(id, item_title, item_title_cn, item_image_url, item_total_cny, quantity, position, system_code)",
      )
      .is("deleted_at", null)
      .order("intl_pay_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false, nullsFirst: false })
      .range(from, to);
    if (data.bucket === "pending") {
      q = q.in("status", PENDING_STATUSES as unknown as string[]);
    } else if (data.bucket === "received") {
      q = q.in("status", RECEIVED_STATUSES as unknown as string[]);
    }
    if (data.q) {
      const s = `%${data.q}%`;
      q = q.or(
        `item_title.ilike.${s},item_title_cn.ilike.${s},source_order_no.ilike.${s},tracking_no.ilike.${s},seller.ilike.${s},system_code.ilike.${s}`,
      );
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const mapped = (rows ?? []).map((r) => {
      const children = ((r as { japan_parcel_items?: Array<{ item_title: string | null; item_title_cn: string | null; item_image_url: string | null; item_total_cny: number | null; quantity: number | null; position: number | null }> }).japan_parcel_items ?? [])
        .slice()
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const first = children[0];
      const firstItemName = first
        ? (first.item_title_cn || first.item_title || "")
        : (r.item_title_cn || r.item_title || "");
      const firstImage =
        r.item_image_url ||
        children.find((c) => c.item_image_url)?.item_image_url ||
        null;
      const itemsTotalCny = children.reduce((s, c) => s + (Number(c.item_total_cny) || 0), 0);
      const totalQty = children.reduce((s, c) => s + (Number(c.quantity) || 0), 0);
      const baseTotal = r.grand_total_cny != null ? Number(r.grand_total_cny) : (itemsTotalCny > 0 ? itemsTotalCny : null);
      const avgUnitCny = baseTotal != null && totalQty > 0 ? baseTotal / totalQty : null;
      return {
        ...r,
        japan_parcel_items: undefined,
        item_image_url: firstImage,
        first_item_name: firstItemName,
        item_count: children.length,
        total_qty: totalQty,
        avg_unit_cny: avgUnitCny,
      };
    });
    return { mode: "parcel" as const, rows: mapped, items: [] as never[], hasMore: mapped.length === data.limit };
  });

/** 待签收计数（首页用） */
export const getMobileCounts = createServerFn({ method: "GET" }).handler(async () => {
  const pendingReceive = await supabaseAdmin
    .from("japan_parcels")
    .select("id", { count: "exact", head: true })
    .is("deleted_at", null)
    .in("status", ["shipping_intl", "purchased", "at_jp_warehouse"]);
  return {
    pendingReceive: pendingReceive.count ?? 0,
  };
});

/** 包裹到手价 context：用于按重量分摊运费 + 关税，得出每个商品的到手价 */
export const getParcelLandedContext = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z.object({ parcel_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const [p, it] = await Promise.all([
      supabaseAdmin
        .from("japan_parcels")
        .select("id, intl_total_jpy, intl_exchange_rate")
        .eq("id", data.parcel_id)
        .maybeSingle(),
      supabaseAdmin
        .from("japan_parcel_items")
        .select("id, item_total_jpy, unit_price_jpy, quantity, weight_g, tariff_rate")
        .eq("parent_id", data.parcel_id),
    ]);
    if (p.error) throw new Error(p.error.message);
    if (it.error) throw new Error(it.error.message);
    return {
      parcel: {
        intl_total_jpy: p.data?.intl_total_jpy ?? null,
        intl_exchange_rate: p.data?.intl_exchange_rate ?? null,
      },
      items: (it.data ?? []) as Array<{
        id: string;
        item_total_jpy: number | null;
        unit_price_jpy: number | null;
        quantity: number | null;
        weight_g: number | null;
        tariff_rate: number | null;
      }>,
    };
  });

/** 一键签收 + 写时间线（仅更新包裹状态/到货照片，不创建库存条目） */
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
      .select("status_timeline")
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

/** 更新单个子商品的到货照片列表 */
export const updateItemArrivalPhotos = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        item_id: z.string().uuid(),
        photo_urls: z.array(z.string().url()).max(9),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { error } = await supabaseAdmin
      .from("japan_parcel_items")
      .update({ arrival_photo_urls: data.photo_urls })
      .eq("id", data.item_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** 根据 user_id 批量查邮箱/昵称，用于"添加人"展示 */
export const getUsersByIds = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).parse(input),
  )
  .handler(async ({ data }) => {
    const out: Record<string, { name: string; email: string | null }> = {};
    // supabase-js admin API has listUsers but no batch get; iterate via getUserById
    await Promise.all(
      data.ids.map(async (id) => {
        try {
          const { data: u } = await supabaseAdmin.auth.admin.getUserById(id);
          const user = u?.user;
          if (!user) return;
          const meta = (user.user_metadata ?? {}) as { name?: string; full_name?: string };
          const name =
            meta.name || meta.full_name || (user.email ? user.email.split("@")[0] : id.slice(0, 6));
          out[id] = { name, email: user.email ?? null };
        } catch {
          // ignore missing user
        }
      }),
    );
    return { users: out };
  });

export const MOBILE_PRICE_TIERS = PRICE_TIERS;
