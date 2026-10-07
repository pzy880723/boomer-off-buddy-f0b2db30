// 门店自提：顾客凭证展示、扫码/手输解析、结果文案（纯函数，前后端共用，不含任何凭证存储）。
export type PickupStatus = "preparing" | "ready" | "redeemed" | "blocked";
export type CustomerPickup = {
  fulfillment_id: string;
  location_id: string | null;
  store_name: string | null;
  store_address: string | null;
  status: PickupStatus;
  code: string | null;
  qr_payload: string | null;
  redeemed_at: string | null;
};

const READY = new Set(["picked", "packed", "handover_ready"]);
const PAID_ONLY = new Set(["paid", "refund_pending", "partially_refunded", "refunded"]);

export function buildCustomerPickups(input: {
  order: { fulfillment_method: string | null; payment_status: string; order_status: string };
  fulfillments: Array<{ id: string; location_id: string | null; status: string; store_name: string | null; store_address: string | null }>;
  codes: Array<{ fulfillment_id: string; code: string; qr_token: string; status: string; redeemed_at: string | null }>;
  refundActive: boolean;
  shortageFulfillmentIds: string[];
}): CustomerPickup[] {
  const { order } = input;
  if (order.fulfillment_method !== "pickup" || !PAID_ONLY.has(order.payment_status)) return [];
  const orderBlocked = order.payment_status !== "paid" || ["cancelled", "closed"].includes(order.order_status) || input.refundActive;
  const byF = new Map(input.codes.map((c) => [c.fulfillment_id, c]));
  return input.fulfillments.map((f) => {
    const c = byF.get(f.id);
    const base = { fulfillment_id: f.id, location_id: f.location_id, store_name: f.store_name, store_address: f.store_address,
      code: null, qr_payload: null, redeemed_at: c?.redeemed_at ?? null };
    if (c?.status === "redeemed" || f.status === "handed_over") return { ...base, status: "redeemed" as const };
    if (!c || c.status !== "active" || orderBlocked || input.shortageFulfillmentIds.includes(f.id)) {
      return { ...base, status: "blocked" as const };
    }
    return { ...base, status: READY.has(f.status) ? ("ready" as const) : ("preparing" as const),
      code: c.code, qr_payload: `BOOMER_PICKUP:${c.qr_token}` };
  });
}

export function parsePickupInput(raw: string): { kind: "qr" | "code"; value: string } | null {
  const v = raw.trim();
  if (/^BOOMER_PICKUP:[0-9a-f]{64}$/.test(v)) return { kind: "qr", value: v };
  if (/^[0-9]{4}$/.test(v)) return { kind: "code", value: v };
  return null;
}

const MESSAGES: Record<string, string> = {
  redeemed: "核销成功，请将商品交给顾客",
  already_redeemed: "该提货凭证已核销，请勿重复交付",
  not_found: "未找到有效提货码，请核对门店和数字",
  wrong_location: "这不是本门店的提货凭证，请让顾客到对应门店提货",
  not_ready: "子单尚未备货完成，请先完成备货",
  refund_blocked: "订单退款处理中或已退款，不能交付",
  shortage_blocked: "子单有缺货待顾客确认，不能交付",
  cancelled: "订单已取消或已关闭，不能交付",
  unpaid: "订单未付款，不能交付",
  forbidden: "你没有该门店的核销权限",
  rate_limited: "输错次数过多，已暂时锁定，请稍后再试或改用扫码",
  invalid_input: "请扫描提货二维码或输入 4 位提货码",
  fulfillment_mismatch: "提货凭证与当前子单不符",
  not_pickup: "该订单不是门店自提订单",
  ready: "已标记备货完成，顾客可来店提货",
  already_ready: "该子单已备货完成",
  exception: "子单处于异常状态，请先处理异常",
  not_found_fulfillment: "子单不存在或不属于该门店",
};
export const pickupResultMessage = (r: string) => MESSAGES[r] ?? "操作失败，请稍后重试";

export function pickupCreateGuard(b: { fulfillment_method: "express" | "pickup"; courier_service_code: string; shipping_address: Record<string, unknown> }):
  null | "pickup_courier_invalid" | "pickup_address_must_be_empty" | "store_pickup_requires_pickup_method" {
  const code = b.courier_service_code.trim().toUpperCase();
  if (b.fulfillment_method === "pickup") {
    if (code !== "STORE_PICKUP") return "pickup_courier_invalid";
    if (Object.keys(b.shipping_address ?? {}).length > 0) return "pickup_address_must_be_empty";
    return null;
  }
  return code === "STORE_PICKUP" ? "store_pickup_requires_pickup_method" : null;
}
