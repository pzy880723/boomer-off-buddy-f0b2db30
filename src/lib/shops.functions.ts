import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type ShopWithStats = {
  id: string;
  kdt_id: number;
  shop_name: string;
  role: string;
  ownership: string;
  status: string;
  address: string | null;
  image_url: string | null;
  image_signed_url: string | null;
  manager: string | null;
  area_sqm: number | null;
  opened_at: string | null;
  phone: string | null;
  notes: string | null;
  last_ping_ok: boolean | null;
  last_ping_at: string | null;
  access_token: string | null;
  revenue_month: number;
  order_count_month: number;
  order_count_total: number;
  item_count: number;
  stock_total: number;
};

export const listShopsWithStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ShopWithStats[]> => {
    const supabase = context.supabase;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [shopsRes, ordersMonthRes, ordersAllRes, itemsRes] = await Promise.all([
      supabase
        .from("youzan_shops")
        .select(
          "id, kdt_id, shop_name, role, status, address, image_url, manager, area_sqm, opened_at, phone, notes, last_ping_ok, last_ping_at"
        )
        .order("role")
        .order("shop_name"),
      supabase
        .from("youzan_orders")
        .select("shop_id, payment, total_fee")
        .gte("pay_time", monthStart),
      supabase.from("youzan_orders").select("shop_id"),
      supabase.from("youzan_items").select("shop_id, stock_qty"),
    ]);

    if (shopsRes.error) throw new Error(shopsRes.error.message);
    const shops = shopsRes.data ?? [];

    const revenueMap = new Map<string, { revenue: number; count: number }>();
    for (const o of (ordersMonthRes.data ?? []) as Array<{
      shop_id: string;
      payment: number | null;
      total_fee: number | null;
    }>) {
      const cur = revenueMap.get(o.shop_id) ?? { revenue: 0, count: 0 };
      cur.revenue += Number(o.payment ?? o.total_fee ?? 0);
      cur.count += 1;
      revenueMap.set(o.shop_id, cur);
    }
    const allOrderMap = new Map<string, number>();
    for (const o of (ordersAllRes.data ?? []) as Array<{ shop_id: string }>) {
      allOrderMap.set(o.shop_id, (allOrderMap.get(o.shop_id) ?? 0) + 1);
    }
    const itemMap = new Map<string, { count: number; stock: number }>();
    for (const it of (itemsRes.data ?? []) as Array<{
      shop_id: string;
      stock_qty: number | null;
    }>) {
      const cur = itemMap.get(it.shop_id) ?? { count: 0, stock: 0 };
      cur.count += 1;
      cur.stock += Number(it.stock_qty ?? 0);
      itemMap.set(it.shop_id, cur);
    }

    return await Promise.all(
      shops.map(async (s) => {
        let signed: string | null = null;
        if (s.image_url) {
          const { data } = await supabase.storage
            .from("shop-images")
            .createSignedUrl(s.image_url, 60 * 60 * 24 * 7);
          signed = data?.signedUrl ?? null;
        }
        const rev = revenueMap.get(s.id) ?? { revenue: 0, count: 0 };
        const items = itemMap.get(s.id) ?? { count: 0, stock: 0 };
        return {
          ...s,
          image_signed_url: signed,
          revenue_month: rev.revenue,
          order_count_month: rev.count,
          order_count_total: allOrderMap.get(s.id) ?? 0,
          item_count: items.count,
          stock_total: items.stock,
        } as ShopWithStats;
      })
    );
  });

export const updateShopMeta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        address: z.string().nullish(),
        manager: z.string().nullish(),
        area_sqm: z.number().nullable().optional(),
        opened_at: z.string().nullish(),
        phone: z.string().nullish(),
        notes: z.string().nullish(),
        image_url: z.string().nullish(),
      })
      .parse(i)
  )
  .handler(async ({ data, context }) => {
    const { id, ...patch } = data;
    const { error } = await context.supabase
      .from("youzan_shops")
      .update(patch)
      .eq("id", id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
