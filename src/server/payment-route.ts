// 支付通道路由：一律以订单/支付记录上固化的快照为准，绝不读取当前全局开关
// (STOREFRONT_PAYMENT_MODE) 去重新解释历史订单。切换默认模式只影响新订单。

export type PaymentChannel = "ordinary_wechat" | "legacy_split";

export interface RoutedPaymentRecord {
  id: string;
  order_id: string;
  payment_channel?: string | null;
  merchant_snapshot?: { mode?: string; merchant_id?: string; app_id?: string } | null;
}

export interface RoutedOrderRecord {
  id: string;
  payment_route?: { version?: number; mode?: string; merchant_id?: string; app_id?: string } | null;
}

export class PaymentRouteError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "PaymentRouteError";
  }
}

/** 已存在的支付记录：通道由记录本身决定。 */
export function resolvePaymentChannel(payment: RoutedPaymentRecord): PaymentChannel {
  const channel = payment.payment_channel ?? "legacy";
  if (channel === "ordinary_wechat") {
    const snapshot = payment.merchant_snapshot;
    if (snapshot?.mode !== "ordinary_wechat" || !snapshot.merchant_id || !snapshot.app_id) {
      throw new PaymentRouteError(
        "普通商户支付快照缺失，禁止改走其它通道",
        "payment_route_snapshot_missing",
      );
    }
    return "ordinary_wechat";
  }
  if (channel === "legacy") return "legacy_split";
  throw new PaymentRouteError("未知的历史支付通道", "payment_route_unknown");
}

/** 未支付订单：通道由下单时固化的 payment_route 决定，不得因开关变化而切换。 */
export function resolveOrderChannel(order: RoutedOrderRecord): PaymentChannel {
  const mode = order.payment_route?.mode;
  if (!mode) return "legacy_split";
  if (mode !== "ordinary_wechat") {
    throw new PaymentRouteError("未知的历史订单支付通道", "payment_route_unknown");
  }
  if (!order.payment_route?.merchant_id || !order.payment_route.app_id) {
    throw new PaymentRouteError(
      "订单支付快照缺失，禁止改走其它通道",
      "payment_route_snapshot_missing",
    );
  }
  return "ordinary_wechat";
}

/**
 * 分账（老通道）配置缺失时必须报错，绝不允许自动降级为总部代收。
 */
export function assertSplitSettlementReady(input: {
  locationIds: string[];
  readyLocationIds: string[];
}) {
  const missing = input.locationIds.filter((id) => !input.readyLocationIds.includes(id));
  if (missing.length) {
    throw new PaymentRouteError(
      `门店结算主体未就绪：${missing.join(",")}`,
      "store_payment_not_ready",
    );
  }
}

/**
 * 普通商户订单即使跨门店，也只保留行级履约/结算归属，不向微信发起分账请求。
 */
export function ordinaryProfitSharePlan(order: RoutedOrderRecord, itemLocationIds: string[]) {
  if (resolveOrderChannel(order) !== "ordinary_wechat") {
    throw new PaymentRouteError("非普通商户订单不适用此计划", "payment_route_unknown");
  }
  return {
    profit_share: false as const,
    sub_orders: [] as never[],
    fulfillment_location_ids: [...new Set(itemLocationIds)].sort(),
  };
}
