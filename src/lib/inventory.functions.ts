import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { generateEpc } from "./inventory.helpers";

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

const SkuInput = z.object({
  category: z.enum(CATEGORY_VALUES),
  price_tier: z.number().positive(),
  name: z.string().min(1).max(120),
  kind: z.enum(["single", "pack"]).default("single"),
  pack_pieces: z.number().int().positive().nullable().optional(),
  weight_g: z.number().nullable().optional(),
  image_url: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  status: z.enum(["active", "archived"]).default("active"),
});

export const listSkus = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z
      .object({
        category: z.string().optional(),
        price_tier: z.number().optional(),
        kind: z.enum(["single", "pack"]).optional(),
        search: z.string().optional(),
        limit: z.number().min(1).max(500).default(200),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    let q = supabase
      .from("inv_skus")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.category) q = q.eq("category", data.category);
    if (data.price_tier != null) q = q.eq("price_tier", data.price_tier);
    if (data.kind) q = q.eq("kind", data.kind);
    if (data.search) {
      const s = `%${data.search}%`;
      q = q.or(`name.ilike.${s},epc.ilike.${s},notes.ilike.${s}`);
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });

export const getSku = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { data: row, error } = await supabase
      .from("inv_skus")
      .select("*")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    const { data: labels } = await supabase
      .from("inv_label_batches")
      .select("*")
      .eq("sku_id", data.id)
      .order("printed_at", { ascending: false })
      .limit(50);
    const { data: lines } = await supabase
      .from("inv_inbound_lines")
      .select("id, qty, unit_price, subtotal, created_at, order_id")
      .eq("sku_id", data.id)
      .order("created_at", { ascending: false })
      .limit(50);
    return { sku: row, labels: labels ?? [], lines: lines ?? [] };
  });

export const createSku = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => SkuInput.parse(input))
  .handler(async ({ data }) => {
    const epc = generateEpc(data.category, data.price_tier);
    const payload = {
      ...data,
      epc,
      pack_pieces: data.kind === "pack" ? data.pack_pieces ?? null : null,
    };
    const { data: row, error } = await supabase
      .from("inv_skus")
      .insert(payload as never)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return { sku: row };
  });

export const updateSku = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid(), patch: SkuInput.partial() }).parse(input),
  )
  .handler(async ({ data }) => {
    const patch = { ...data.patch } as Record<string, unknown>;
    if (patch.kind === "single") patch.pack_pieces = null;
    const { error } = await supabase.from("inv_skus").update(patch as never).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const createLabelBatch = createServerFn({ method: "POST" })
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
  .handler(async ({ data }) => {
    const { data: row, error } = await supabase
      .from("inv_label_batches")
      .insert(data as never)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return { batch: row };
  });

export const lookupSkusByEpcs = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ epcs: z.array(z.string()).min(1).max(2000) }).parse(input),
  )
  .handler(async ({ data }) => {
    const uniq = Array.from(new Set(data.epcs.map((e) => e.trim()).filter(Boolean)));
    if (uniq.length === 0) return { skus: [] };
    const { data: rows, error } = await supabase
      .from("inv_skus")
      .select("id, epc, category, price_tier, name, kind, pack_pieces, image_url")
      .in("epc", uniq);
    if (error) throw new Error(error.message);
    return { skus: rows ?? [] };
  });

export const submitInbound = createServerFn({ method: "POST" })
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
  .handler(async ({ data }) => {
    // 取 SKU 价格
    const skuIds = Array.from(new Set(data.scans.map((s) => s.sku_id)));
    const { data: skus, error: skuErr } = await supabase
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

    const { data: order, error: orderErr } = await supabase
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

    const { error: linesErr } = await supabase
      .from("inv_inbound_lines")
      .insert(lines.map((l) => ({ ...l, order_id: order.id })) as never);
    if (linesErr) throw new Error(linesErr.message);

    // 累加库存（并发安全函数）
    for (const s of data.scans) {
      const { error: rpcErr } = await supabase.rpc("inv_apply_inbound_stock", {
        p_sku_id: s.sku_id,
        p_delta: s.qty,
      });
      if (rpcErr) throw new Error(rpcErr.message);
    }

    return { order_id: order.id, total_qty: totalQty, total_value_cny: totalValue };
  });

export const listInboundOrders = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z.object({ limit: z.number().min(1).max(200).default(50) }).parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const { data: rows, error } = await supabase
      .from("inv_inbound_orders")
      .select("*")
      .order("scanned_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });

export const getInboundOrder = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { data: order, error } = await supabase
      .from("inv_inbound_orders")
      .select("*")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    const { data: lines } = await supabase
      .from("inv_inbound_lines")
      .select("*, inv_skus(id, name, category, price_tier, kind, epc, image_url)")
      .eq("order_id", data.id);
    return { order, lines: lines ?? [] };
  });
