/**
 * 「我的订单 / 售后」角标汇总。
 *
 * - 归属一律由调用方传入服务端解析出的 customer_id。
 * - 轻量读取：纯计数，不补报价、不签图，不查积分 / 优惠券 / 会员权益。
 * - **无服务端缓存**：确认退款 / 缺货状态变更后必须立刻反映，客户端自己的 30 秒单飞即可，
 *   服务端再叠一层缓存会造成最长两层 60 秒延迟。
 * - 订单计数失败时省略 order_counts（客户端应保持原值），绝不伪造为 0。
 */
import type { OrderCounts } from "./storefront-order-list.server";

export type AfterSalesCounts = { pending_count: number; pending_shortage_count: number };

export type SummaryData = AfterSalesCounts & { order_counts?: OrderCounts };

export type SummaryDeps = {
  afterSales(customerId: string): Promise<AfterSalesCounts>;
  orderCounts(customerId: string): Promise<OrderCounts>;
};

export async function loadStorefrontSummary(
  customerId: string,
  deps: SummaryDeps,
): Promise<SummaryData> {
  // 售后待办是安全关键读取：失败必须抛错（由路由返回 5xx），不能假 0。
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
