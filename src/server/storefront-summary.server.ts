/**
 * 「我的订单 / 售后」角标汇总。
 *
 * - 归属一律由调用方传入服务端解析出的 customer_id，缓存按账号隔离。
 * - 轻量读取：只查售后待办与订单计数，不查积分、优惠券、会员权益。
 * - 订单计数失败时省略 order_counts（客户端应保持原值），绝不伪造为 0。
 */
import type { OrderCounts } from "./storefront-order-list.server";

export const SUMMARY_CACHE_TTL_MS = 30_000;

export type AfterSalesCounts = { pending_count: number; pending_shortage_count: number };

export type SummaryData = AfterSalesCounts & { order_counts?: OrderCounts };

export type SummaryDeps = {
  afterSales(customerId: string): Promise<AfterSalesCounts>;
  orderCounts(customerId: string): Promise<OrderCounts>;
};

type Entry = { expiresAt: number; data: SummaryData };

export function createSummaryCache(now: () => number = Date.now) {
  const entries = new Map<string, Entry>();

  async function load(customerId: string, deps: SummaryDeps): Promise<SummaryData> {
    const [afterSales, orderCounts] = await Promise.all([
      deps.afterSales(customerId),
      deps.orderCounts(customerId).catch(() => null),
    ]);
    const data: SummaryData = {
      pending_count: Math.max(0, Math.trunc(afterSales.pending_count)),
      pending_shortage_count: Math.max(0, Math.trunc(afterSales.pending_shortage_count)),
    };
    if (orderCounts) data.order_counts = orderCounts;
    return data;
  }

  return {
    async get(customerId: string, deps: SummaryDeps): Promise<SummaryData> {
      const hit = entries.get(customerId);
      if (hit && hit.expiresAt > now()) return hit.data;
      const data = await load(customerId, deps);
      // 计数缺失（取数失败）时不缓存，下次请求继续重试
      if (data.order_counts) entries.set(customerId, { expiresAt: now() + SUMMARY_CACHE_TTL_MS, data });
      else entries.delete(customerId);
      return data;
    },
    clear() {
      entries.clear();
    },
  };
}

export type SummaryCache = ReturnType<typeof createSummaryCache>;
