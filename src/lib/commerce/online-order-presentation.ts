export type OnlineOrderView = "pending" | "fulfillment" | "completed" | "after_sale" | "refunded" | "cancelled" | "unknown";
type State = { view: OnlineOrderView; label: string; tone: "neutral" | "warning" | "success" | "info" };

// Payment and fulfillment are separate lifecycles. A successful refund must win
// over stale fulfillment/closed labels, without pretending a partial refund is full.
export function onlineOrderState(order: {order_status: string; payment_status: string}): State {
  if (order.payment_status === "refunded") return {view:"refunded",label:"已退款",tone:"neutral"};
  if (order.payment_status === "refund_pending") return {view:"after_sale",label:"退款中",tone:"warning"};
  if (order.payment_status === "partially_refunded") return {view:"after_sale",label:"部分退款",tone:"warning"};
  if (["cancelled", "closed"].includes(order.order_status)) return {view:"cancelled",label:order.order_status === "closed" ? "已关闭" : "已取消",tone:"neutral"};
  if (order.order_status === "after_sale") return {view:"after_sale",label:"售后中",tone:"warning"};
  if (order.order_status === "completed") return {view:"completed",label:"已完成",tone:"success"};
  if (order.order_status === "pending_payment" && order.payment_status === "unpaid") return {view:"pending",label:"待付款",tone:"warning"};
  if (["confirmed", "processing"].includes(order.order_status) && order.payment_status === "paid") return {view:"fulfillment",label:"履约中",tone:"info"};
  return {view:"unknown",label:"状态待核对",tone:"warning"};
}

const platformLabels: Record<string, string> = {miniapp:"小程序",app:"APP",web:"网页商城",delivery:"外卖订单"};
export function orderSourceLabel(order: {source_channel: string; metadata?: unknown}): string {
  const channels: Record<string, string> = {pos:"门店收银",youzan:"有赞",manual:"人工订单",delivery:"外卖订单"};
  if (order.source_channel !== "storefront") return channels[order.source_channel] ?? "来源未记录";
  const origin = (order.metadata as {sales_origin?: {platform?: unknown}} | null)?.sales_origin;
  return typeof origin?.platform === "string" && Object.hasOwn(platformLabels, origin.platform)
    ? platformLabels[origin.platform] : "自营线上 · 来源未记录";
}
