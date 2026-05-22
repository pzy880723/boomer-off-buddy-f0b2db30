import { createServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";

/**
 * 总部业务汇总：核心 4 项
 * - 总营业额（本月）
 * - 总订单数（本月）
 * - 总在售商品数
 * - 总库存量
 *
 * 数据全部来自本地 youzan_orders / youzan_items（由同步任务定时回填）。
 * 没数据时返回 0，前端展示「等待首次同步」。
 */
export const getYouzanSummary = createServerFn({ method: "GET" }).handler(
  async () => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [ordersRes, itemsRes, shopsRes] = await Promise.all([
      supabase
        .from("youzan_orders")
        .select("payment, total_fee", { count: "exact" })
        .gte("pay_time", monthStart),
      supabase
        .from("youzan_items")
        .select("stock_qty, is_listed, shop_id"),
      supabase
        .from("youzan_shops")
        .select("id, last_ping_ok, last_ping_at"),
    ]);

    const orders = (ordersRes.data ?? []) as Array<{
      payment: number | null;
      total_fee: number | null;
    }>;
    const items = (itemsRes.data ?? []) as Array<{
      stock_qty: number | null;
      is_listed: boolean | null;
      shop_id: string;
    }>;
    const shops = (shopsRes.data ?? []) as Array<{
      id: string;
      last_ping_ok: boolean | null;
      last_ping_at: string | null;
    }>;

    const revenue = orders.reduce(
      (s, o) => s + Number(o.payment ?? o.total_fee ?? 0),
      0,
    );
    const orderCount = ordersRes.count ?? orders.length;
    const listedCount = items.filter((i) => i.is_listed).length;
    const stockTotal = items.reduce((s, i) => s + Number(i.stock_qty ?? 0), 0);

    const itemsByShop: Record<string, number> = {};
    for (const it of items) {
      itemsByShop[it.shop_id] = (itemsByShop[it.shop_id] ?? 0) + 1;
    }

    const lastSyncAt = shops
      .map((s) => s.last_ping_at)
      .filter((x): x is string => !!x)
      .sort()
      .at(-1) ?? null;

    return {
      revenueMonthCny: revenue,
      orderCountMonth: orderCount,
      listedItemCount: listedCount,
      stockTotal,
      shopCount: shops.length,
      shopOnline: shops.filter((s) => s.last_ping_ok).length,
      lastSyncAt,
      hasData: orders.length > 0 || items.length > 0,
      itemsByShop,
    };
  },
);

/**
 * 每家分店的「本月营业额 + 订单数」明细（用于门店卡片）
 */
export const getShopSalesBreakdown = createServerFn({ method: "GET" }).handler(
  async () => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const { data, error } = await supabase
      .from("youzan_orders")
      .select("shop_id, payment, total_fee")
      .gte("pay_time", monthStart);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{
      shop_id: string;
      payment: number | null;
      total_fee: number | null;
    }>;
    const map = new Map<string, { revenue: number; count: number }>();
    for (const r of rows) {
      const cur = map.get(r.shop_id) ?? { revenue: 0, count: 0 };
      cur.revenue += Number(r.payment ?? r.total_fee ?? 0);
      cur.count += 1;
      map.set(r.shop_id, cur);
    }
    return {
      breakdown: Object.fromEntries(map) as Record<
        string,
        { revenue: number; count: number }
      >,
    };
  },
);
