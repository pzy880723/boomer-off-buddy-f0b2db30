/**
 * 缺货售后 Case DTO（前后端合同 v1）。纯映射，无 IO。
 * can_confirm 只能由服务端真实资格生成，UI 不得自行判断。
 */

export type ShortageRefundState =
  | "awaiting_confirmation"
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "manual_review"
  // 历史值（旧腾讯版本写入），对客户端一律折叠为可读状态
  | "not_required"
  | "refund_pending"
  | "refund_completed";

export type ShortageCase = {
  id: string;
  order_id: string;
  order_no: string | null;
  store_name: string | null;
  product_name: string | null;
  thumbnail_url: string | null;
  quantity: number;
  reason: string | null;
  status: string;
  refund_state: ShortageRefundState;
  refund_goods_fen: number;
  refund_shipping_fen: number;
  refund_total_fen: number;
  quote_version: string | null;
  can_confirm: boolean;
  /** can_confirm=false 时的机器可读原因；可确认时为 null。 */
  can_confirm_reason: ShortageBlockReason | null;
  created_at: string;
  customer_responded_at: string | null;
  refund_requested_at: string | null;
  refunded_at: string | null;
};

export type ShortageRow = {
  id: string;
  order_id: string | null;
  quantity: number;
  reason: string | null;
  status: string;
  refund_state: string;
  product_name: string | null;
  quote_version: string | null;
  refund_goods_fen: number | null;
  refund_shipping_fen: number | null;
  refund_total_fen: number | null;
  created_at: string;
  customer_responded_at: string | null;
  refund_requested_at: string | null;
  refunded_at: string | null;
};

/** 历史 refund_state → 客户端契约状态。 */
export function normalizeRefundState(value: string): ShortageRefundState {
  switch (value) {
    case "refund_pending":
      return "manual_review";
    case "refund_completed":
      return "succeeded";
    case "awaiting_confirmation":
    case "queued":
    case "processing":
    case "succeeded":
    case "failed":
    case "manual_review":
      return value;
    default:
      return "manual_review";
  }
}

export type ShortageBlockReason =
  | "already_requested"
  | "manual_review"
  | "no_quote"
  | "refund_worker_disabled";

/** can_confirm 的唯一判定（服务端），顺带给出机器可读原因。 */
export function evaluateConfirmable(
  row: ShortageRow,
  extra: { has_refund_intent: boolean; refund_execution_enabled: boolean },
): { can_confirm: boolean; can_confirm_reason: ShortageBlockReason | null } {
  const refundState = normalizeRefundState(row.refund_state);
  const total = row.refund_total_fen ?? 0;
  if (extra.has_refund_intent) {
    return { can_confirm: false, can_confirm_reason: "already_requested" };
  }
  if (refundState !== "awaiting_confirmation" || row.status !== "pending_customer") {
    return { can_confirm: false, can_confirm_reason: "manual_review" };
  }
  if (!row.quote_version || total <= 0) {
    return { can_confirm: false, can_confirm_reason: "no_quote" };
  }
  // 真实退款执行未开启时，服务端不接受确认写入，UI 也不得显示可确认。
  if (!extra.refund_execution_enabled) {
    return { can_confirm: false, can_confirm_reason: "refund_worker_disabled" };
  }
  return { can_confirm: true, can_confirm_reason: null };
}

export function toShortageCase(
  row: ShortageRow,
  extra: {
    order_no: string | null;
    store_name: string | null;
    thumbnail_url: string | null;
    has_refund_intent: boolean;
    refund_execution_enabled: boolean;
  },
): ShortageCase {
  const refundState = normalizeRefundState(row.refund_state);
  const total = row.refund_total_fen ?? 0;
  const confirmable = evaluateConfirmable(row, extra);
  return {
    id: row.id,
    order_id: row.order_id ?? "",
    order_no: extra.order_no,
    store_name: extra.store_name,
    product_name: row.product_name,
    // 只允许压缩衍生图；无法生成时为 null，绝不回退原图
    thumbnail_url: extra.thumbnail_url,
    quantity: row.quantity,
    reason: row.reason,
    status: row.status,
    refund_state: refundState,
    refund_goods_fen: row.refund_goods_fen ?? 0,
    refund_shipping_fen: row.refund_shipping_fen ?? 0,
    refund_total_fen: total,
    quote_version: row.quote_version,
    can_confirm:
      !extra.has_refund_intent &&
      refundState === "awaiting_confirmation" &&
      row.status === "pending_customer" &&
      !!row.quote_version &&
      total > 0,
    created_at: row.created_at,
    customer_responded_at: row.customer_responded_at,
    refund_requested_at: row.refund_requested_at,
    refunded_at: row.refunded_at,
  };
}

/** 客户确认退款的幂等键（前后端必须一致）。 */
export function confirmIdempotencyKey(shortageId: string, quoteVersion: string): string {
  return `shortage:${shortageId}:${quoteVersion}`;
}
