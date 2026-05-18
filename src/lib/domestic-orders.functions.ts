import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

export const PLATFORMS = ["xianyu", "douyin", "xiaohongshu", "wechat", "pinduoduo"] as const;
export const STATUSES = ["pending_pay", "paid", "shipped", "delivered", "completed"] as const;
export type DomesticPlatform = (typeof PLATFORMS)[number];
export type DomesticStatus = (typeof STATUSES)[number];

export const PLATFORM_LABEL: Record<DomesticPlatform, string> = {
  xianyu: "闲鱼",
  douyin: "抖音",
  xiaohongshu: "小红书",
  wechat: "微信",
  pinduoduo: "拼多多",
};

export const STATUS_LABEL: Record<DomesticStatus, string> = {
  pending_pay: "待付款",
  paid: "已付款",
  shipped: "已发货",
  delivered: "已签收",
  completed: "已完成",
};

const OrderInput = z.object({
  platform: z.enum(PLATFORMS),
  source_order_no: z.string().nullable().optional(),
  seller_name: z.string().nullable().optional(),
  seller_handle: z.string().nullable().optional(),
  item_title: z.string().nullable().optional(),
  item_image_url: z.string().nullable().optional(),
  qty: z.number().nullable().optional(),
  price_cny: z.number().nullable().optional(),
  shipping_cny: z.number().nullable().optional(),
  total_cny: z.number().nullable().optional(),
  purchased_at: z.string().nullable().optional(),
  tracking_no: z.string().nullable().optional(),
  carrier: z.string().nullable().optional(),
  receiver_name: z.string().nullable().optional(),
  receiver_phone: z.string().nullable().optional(),
  receiver_address: z.string().nullable().optional(),
  status: z.enum(STATUSES).default("paid"),
  chat_summary: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  screenshot_urls: z.array(z.string()).optional(),
  raw_payload: z.unknown().optional(),
});

export type DomesticOrderInput = z.infer<typeof OrderInput>;

function computeCompleteness(o: Partial<DomesticOrderInput>): number {
  const fields = [
    "source_order_no",
    "item_title",
    "total_cny",
    "purchased_at",
    "tracking_no",
    "receiver_name",
    "receiver_phone",
    "receiver_address",
  ];
  const filled = fields.filter((k) => {
    const v = (o as Record<string, unknown>)[k];
    return v != null && v !== "";
  }).length;
  return Math.round((filled / fields.length) * 100);
}

export const listDomesticOrders = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z
      .object({
        platform: z.enum(PLATFORMS).optional(),
        status: z.enum(STATUSES).optional(),
        search: z.string().optional(),
        limit: z.number().min(1).max(500).default(100),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    let q = supabase
      .from("domestic_orders")
      .select("*")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.platform) q = q.eq("platform", data.platform);
    if (data.status) q = q.eq("status", data.status);
    if (data.search) {
      const s = `%${data.search}%`;
      q = q.or(
        `source_order_no.ilike.${s},item_title.ilike.${s},seller_name.ilike.${s},tracking_no.ilike.${s},receiver_name.ilike.${s}`,
      );
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });

export const countDomesticOrders = createServerFn({ method: "GET" }).handler(async () => {
  const { data, error } = await supabase
    .from("domestic_orders")
    .select("platform, status")
    .is("deleted_at", null);
  if (error) throw new Error(error.message);
  const byPlatform: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const r of data ?? []) {
    byPlatform[r.platform] = (byPlatform[r.platform] ?? 0) + 1;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  }
  return { byPlatform, byStatus, total: data?.length ?? 0 };
});

export const getDomesticOrder = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { data: row, error } = await supabase
      .from("domestic_orders")
      .select("*")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const bulkInsertDomesticOrders = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        orders: z.array(OrderInput).min(1).max(50),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    let inserted = 0;
    let skipped = 0;
    const ids: string[] = [];
    for (const o of data.orders) {
      const payload = {
        ...o,
        completeness: computeCompleteness(o),
        screenshot_urls: o.screenshot_urls ?? [],
      };
      // skip duplicates: (platform, source_order_no) unique partial index
      if (o.source_order_no) {
        const { data: existing } = await supabase
          .from("domestic_orders")
          .select("id")
          .eq("platform", o.platform)
          .eq("source_order_no", o.source_order_no)
          .is("deleted_at", null)
          .maybeSingle();
        if (existing) {
          skipped++;
          ids.push(existing.id);
          continue;
        }
      }
      const { data: row, error } = await supabase
        .from("domestic_orders")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      inserted++;
      ids.push(row.id);
    }
    return { inserted, skipped, ids };
  });

export const updateDomesticOrder = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        patch: OrderInput.partial(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const patch = { ...data.patch } as Record<string, unknown>;
    if (Object.keys(patch).length === 0) return { ok: true };
    // recompute completeness if any tracked field present
    const { data: current } = await supabase
      .from("domestic_orders")
      .select("*")
      .eq("id", data.id)
      .single();
    if (current) {
      patch.completeness = computeCompleteness({ ...current, ...patch } as Partial<DomesticOrderInput>);
    }
    const { error } = await supabase.from("domestic_orders").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setDomesticOrderStatus = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid(), status: z.enum(STATUSES) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { error } = await supabase
      .from("domestic_orders")
      .update({ status: data.status })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const removeDomesticOrder = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { error } = await supabase
      .from("domestic_orders")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
