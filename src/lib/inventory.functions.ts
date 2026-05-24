import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { generateEpc, generateSkuCode } from "./inventory.helpers";

const CATEGORY_VALUES = [
  "jp_porcelain",
  "eu_porcelain",
  "vintage_toy",
  "anime_goods",
  "media",
  "digital",
  "jewelry",
  "fashion",
  "daily",
  "antique",
] as const;

const MetaInput = z.object({
  category: z.enum(CATEGORY_VALUES),
  name: z.string().min(1).max(120),
  sku_code: z.string().trim().max(64).nullable().optional(),
  weight_g: z.number().nullable().optional(),
  image_url: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  grade: z.enum(["N", "S", "A", "B", "C", "J"]).nullable().optional(),
});

// 价格档校验：> 0、≤ 9999.9、最多 1 位小数
const priceTierSchema = z
  .number()
  .positive()
  .max(9999.9)
  .refine((n) => Math.round(n * 10) === n * 10, "价格档最多保留 1 位小数");

export const listSkus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        category: z.string().optional(),
        price_tier: z.number().optional(),
        kind: z.enum(["single", "pack", "bundle"]).optional(),
        exclude_kind: z.enum(["single", "pack", "bundle"]).optional(),
        search: z.string().optional(),
        limit: z.number().min(1).max(500).default(200),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    let q = sb
      .from("inv_skus")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.category) q = q.eq("category", data.category);
    if (data.price_tier != null) q = q.eq("price_tier", data.price_tier);
    if (data.kind) q = q.eq("kind", data.kind);
    if (data.exclude_kind) q = q.neq("kind", data.exclude_kind);
    if (data.search) {
      const s = `%${data.search}%`;
      q = q.or(`name.ilike.${s},epc.ilike.${s},sku_code.ilike.${s},notes.ilike.${s}`);
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });

export const getSku = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const { data: row, error } = await sb
      .from("inv_skus")
      .select("*")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);

    // 解析组包子项
    let bundleChildren: Array<{ id: string; name: string; epc: string; image_url: string | null; price_tier: number; qty: number }> = [];
    const bi = (row as { bundle_items?: unknown }).bundle_items;
    if (row && row.kind === "bundle" && Array.isArray(bi) && bi.length > 0) {
      const items = bi as Array<{ sku_id: string; qty: number }>;
      const ids = items.map((x) => x.sku_id);
      const { data: childRows } = await sb
        .from("inv_skus")
        .select("id, name, epc, image_url, price_tier")
        .in("id", ids);
      const map = new Map((childRows ?? []).map((r) => [r.id, r]));
      bundleChildren = items
        .map((it) => {
          const c = map.get(it.sku_id);
          if (!c) return null;
          return {
            id: c.id,
            name: c.name,
            epc: c.epc,
            image_url: c.image_url,
            price_tier: Number(c.price_tier),
            qty: it.qty,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x != null);
    }

    const { data: labels } = await sb
      .from("inv_label_batches")
      .select("*")
      .eq("sku_id", data.id)
      .order("printed_at", { ascending: false })
      .limit(50);
    const { data: lines } = await sb
      .from("inv_inbound_lines")
      .select("id, qty, unit_price, subtotal, created_at, order_id")
      .eq("sku_id", data.id)
      .order("created_at", { ascending: false })
      .limit(50);
    return { sku: row, labels: labels ?? [], lines: lines ?? [], bundle_children: bundleChildren };
  });

/** 标准商品：一次为多个价格档生成多条 single SKU */
export const createStandardSkus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    MetaInput.extend({
      price_tiers: z.array(priceTierSchema).min(1).max(50),
      epc_map: z.record(z.string(), z.string()).optional(),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const tiers = Array.from(new Set(data.price_tiers)).sort((a, b) => a - b);
    const code = (data.sku_code?.trim() || generateSkuCode(data.category, "single"));
    const rows = tiers.map((t) => ({
      category: data.category,
      name: data.name.trim(),
      sku_code: code,
      price_tier: t,
      is_custom_price: false,
      kind: "single" as const,
      pack_pieces: null,
      bundle_items: [],
      weight_g: data.weight_g ?? null,
      image_url: data.image_url ?? null,
      notes: data.notes ?? null,
      status: "active" as const,
      epc: data.epc_map?.[String(t)] || generateEpc(data.category, t),
    }));
    const { data: inserted, error } = await sb
      .from("inv_skus")
      .insert(rows as never)
      .select("*");
    if (error) throw new Error(error.message);
    return { skus: inserted ?? [] };
  });

/** 自定义商品：单条 SKU，价格手填 */
export const createCustomSku = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    MetaInput.extend({
      price: z.number().positive().max(99999.9),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const payload = {
      category: data.category,
      name: data.name.trim(),
      sku_code: data.sku_code?.trim() || generateSkuCode(data.category, "single"),
      price_tier: Math.round(data.price * 100) / 100,
      is_custom_price: true,
      kind: "single" as const,
      pack_pieces: null,
      bundle_items: [],
      weight_g: data.weight_g ?? null,
      image_url: data.image_url ?? null,
      notes: data.notes ?? null,
      status: "active" as const,
      epc: generateEpc(data.category, data.price),
    };
    const { data: row, error } = await sb
      .from("inv_skus")
      .insert(payload as never)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return { sku: row };
  });

/** 组包商品：引用若干已有 SKU 形成一个新的独立 SKU */
export const createBundleSku = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    MetaInput.extend({
      price: z.number().positive().max(99999.9),
      items: z
        .array(z.object({ sku_id: z.string().uuid(), qty: z.number().int().positive() }))
        .min(1)
        .max(50),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    // 校验子 SKU 存在且不是 bundle
    const ids = data.items.map((x) => x.sku_id);
    const { data: children, error: cErr } = await sb
      .from("inv_skus")
      .select("id, kind")
      .in("id", ids);
    if (cErr) throw new Error(cErr.message);
    if ((children?.length ?? 0) !== new Set(ids).size) {
      throw new Error("部分子 SKU 不存在");
    }
    if (children?.some((c) => c.kind === "bundle")) {
      throw new Error("组包内不能再包含另一个组包");
    }

    const totalPieces = data.items.reduce((s, x) => s + x.qty, 0);
    const payload = {
      category: data.category,
      name: data.name.trim(),
      sku_code: data.sku_code?.trim() || generateSkuCode(data.category, "bundle"),
      price_tier: Math.round(data.price * 100) / 100,
      is_custom_price: true,
      kind: "bundle" as const,
      pack_pieces: totalPieces,
      bundle_items: data.items,
      weight_g: data.weight_g ?? null,
      image_url: data.image_url ?? null,
      notes: data.notes ?? null,
      status: "active" as const,
      epc: generateEpc(data.category, data.price),
    };
    const { data: row, error } = await sb
      .from("inv_skus")
      .insert(payload as never)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return { sku: row };
  });

export const updateSku = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        patch: z
          .object({
            name: z.string().min(1).max(120).optional(),
            sku_code: z.string().trim().max(64).nullable().optional(),
            weight_g: z.number().nullable().optional(),
            image_url: z.string().nullable().optional(),
            notes: z.string().nullable().optional(),
            status: z.enum(["active", "archived"]).optional(),
            price_tier: z.number().positive().max(99999.9).optional(),
          })
          .strict(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("inv_skus")
      .update(data.patch as never)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** 批量更新一组标准商品的共用字段（按 sku_code 或 category|name 聚合），可选同步价格档 */
export const updateStandardProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        key: z.string().min(1),
        patch: z
          .object({
            name: z.string().min(1).max(120).optional(),
            sku_code: z.string().trim().max(64).nullable().optional(),
            weight_g: z.number().nullable().optional(),
            image_url: z.string().nullable().optional(),
            notes: z.string().nullable().optional(),
          })
          .strict(),
        price_tiers: z.array(priceTierSchema).min(1).max(50).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const { data: rows, error: qErr } = await sb
      .from("inv_skus")
      .select("id, sku_code, category, name, price_tier, stock_qty")
      .eq("kind", "single")
      .eq("is_custom_price", false);
    if (qErr) throw new Error(qErr.message);
    const matched = (rows ?? []).filter(
      (r) => ((r.sku_code && r.sku_code.trim()) || `${r.category}|${r.name}`) === data.key,
    );
    if (matched.length === 0) throw new Error("找不到对应的标准商品");
    const ids = matched.map((r) => r.id);

    if (Object.keys(data.patch).length > 0) {
      const { error } = await sb.from("inv_skus").update(data.patch as never).in("id", ids);
      if (error) throw new Error(error.message);
    }

    let added = 0;
    let removed = 0;
    if (data.price_tiers && data.price_tiers.length > 0) {
      const wanted = Array.from(new Set(data.price_tiers)).sort((a, b) => a - b);
      const current = new Map(matched.map((r) => [Number(r.price_tier), r]));
      const ref = matched[0];
      const category = ref.category as string;
      const name = (data.patch.name ?? ref.name) as string;
      const sku_code =
        data.patch.sku_code !== undefined ? data.patch.sku_code : (ref.sku_code ?? null);

      const toAdd = wanted.filter((t) => !current.has(t));
      if (toAdd.length > 0) {
        const inserts = toAdd.map((t) => ({
          category,
          name,
          sku_code: sku_code ?? generateSkuCode(category, "single"),
          price_tier: t,
          is_custom_price: false,
          kind: "single" as const,
          pack_pieces: null,
          bundle_items: [],
          weight_g: (data.patch.weight_g ?? null) as number | null,
          image_url: (data.patch.image_url ?? null) as string | null,
          notes: (data.patch.notes ?? null) as string | null,
          status: "active" as const,
          epc: generateEpc(category, t),
        }));
        const { error } = await sb.from("inv_skus").insert(inserts as never);
        if (error) throw new Error(error.message);
        added = inserts.length;
      }

      const toRemove = Array.from(current.entries()).filter(([t]) => !wanted.includes(t));
      for (const [t, row] of toRemove) {
        if ((row.stock_qty ?? 0) > 0) {
          throw new Error(`价格档 ¥${t} 仍有 ${row.stock_qty} 件库存，无法删除`);
        }
        await safeDeleteSkuById(sb as never, row.id);
        removed += 1;
      }
    }

    return { ok: true, updated: ids.length, added, removed };
  });

async function safeDeleteSkuById(sb: typeof supabaseAdmin, id: string) {
  const { data: row, error: rErr } = await sb
    .from("inv_skus")
    .select("id, stock_qty, name")
    .eq("id", id)
    .single();
  if (rErr) throw new Error(rErr.message);
  if (!row) throw new Error("SKU 不存在");
  if ((row.stock_qty ?? 0) > 0) {
    throw new Error(`【${row.name}】仍有 ${row.stock_qty} 件库存，无法删除`);
  }
  const { data: lines } = await sb
    .from("inv_inbound_lines")
    .select("id")
    .eq("sku_id", id)
    .limit(1);
  if ((lines?.length ?? 0) > 0) {
    throw new Error(`【${row.name}】存在入库记录，请先归档而不是删除`);
  }
  await sb.from("inv_label_batches").delete().eq("sku_id", id);
  const { error: dErr } = await sb.from("inv_skus").delete().eq("id", id);
  if (dErr) throw new Error(dErr.message);
}

export const deleteSku = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await safeDeleteSkuById(context.supabase as never, data.id);
    return { ok: true };
  });

export const deleteStandardProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ key: z.string().min(1) }).parse(input))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const { data: rows, error } = await sb
      .from("inv_skus")
      .select("id, sku_code, category, name")
      .eq("kind", "single")
      .eq("is_custom_price", false);
    if (error) throw new Error(error.message);
    const ids = (rows ?? [])
      .filter((r) => ((r.sku_code && r.sku_code.trim()) || `${r.category}|${r.name}`) === data.key)
      .map((r) => r.id);
    if (ids.length === 0) throw new Error("找不到对应的标准商品");
    for (const id of ids) {
      await safeDeleteSkuById(sb as never, id);
    }
    return { ok: true, deleted: ids.length };
  });

export const createLabelBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        sku_id: z.string().uuid(),
        qty: z.number().int().min(1).max(1000),
        operator: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("inv_label_batches")
      .insert(data as never)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return { batch: row };
  });

export const lookupSkusByEpcs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ epcs: z.array(z.string()).min(1).max(2000) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const uniq = Array.from(new Set(data.epcs.map((e) => e.trim()).filter(Boolean)));
    if (uniq.length === 0) return { skus: [] };
    const { data: rows, error } = await context.supabase
      .from("inv_skus")
      .select("id, epc, category, price_tier, name, kind, pack_pieces, sku_code, image_url")
      .in("epc", uniq);
    if (error) throw new Error(error.message);
    return { skus: rows ?? [] };
  });

export const submitInbound = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        scans: z
          .array(z.object({ sku_id: z.string().uuid(), qty: z.number().int().positive() }))
          .min(1)
          .max(500),
        operator: z.string().nullable().optional(),
        source: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    // 取 SKU 价格
    const skuIds = Array.from(new Set(data.scans.map((s) => s.sku_id)));
    const { data: skus, error: skuErr } = await sb
      .from("inv_skus")
      .select("id, price_tier")
      .in("id", skuIds);
    if (skuErr) throw new Error(skuErr.message);
    const priceMap = new Map((skus ?? []).map((s) => [s.id, Number(s.price_tier)]));

    let totalQty = 0;
    let totalValue = 0;
    const lines = data.scans.map((s) => {
      const price = priceMap.get(s.sku_id) ?? 0;
      const subtotal = Math.round(price * s.qty * 100) / 100;
      totalQty += s.qty;
      totalValue = Math.round((totalValue + subtotal) * 100) / 100;
      return { sku_id: s.sku_id, qty: s.qty, unit_price: price, subtotal };
    });

    const { data: order, error: orderErr } = await sb
      .from("inv_inbound_orders")
      .insert({
        operator: data.operator ?? null,
        source: data.source ?? null,
        notes: data.notes ?? null,
        total_qty: totalQty,
        total_value_cny: totalValue,
      } as never)
      .select("id")
      .single();
    if (orderErr) throw new Error(orderErr.message);

    const { error: linesErr } = await sb
      .from("inv_inbound_lines")
      .insert(lines.map((l) => ({ ...l, order_id: order.id })) as never);
    if (linesErr) throw new Error(linesErr.message);

    // 累加库存（并发安全函数）
    for (const s of data.scans) {
      const { error: rpcErr } = await supabaseAdmin.rpc("inv_apply_inbound_stock", {
        p_sku_id: s.sku_id,
        p_delta: s.qty,
      });
      if (rpcErr) throw new Error(rpcErr.message);
    }

    return { order_id: order.id, total_qty: totalQty, total_value_cny: totalValue };
  });

export const listInboundOrders = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ limit: z.number().min(1).max(200).default(50) }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("inv_inbound_orders")
      .select("*")
      .order("scanned_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });

export const getInboundOrder = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const { data: order, error } = await sb
      .from("inv_inbound_orders")
      .select("*")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    const { data: lines } = await sb
      .from("inv_inbound_lines")
      .select("*, inv_skus(id, name, category, price_tier, kind, epc, sku_code, image_url)")
      .eq("order_id", data.id);
    return { order, lines: lines ?? [] };
  });
