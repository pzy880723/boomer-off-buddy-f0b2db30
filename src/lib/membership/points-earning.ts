// ERP is the only points ledger. Pure fact builder for the trusted paid-order adapter.
// Rule (pending final sign-off, feature stays disabled): 1 point per whole yuan of goods actually paid,
// excluding shipping, floored on the cumulative net after refunds (computed in the database).
export const POINTS_EARNING_RULE_VERSION = "paid_goods_1yuan_1pt_v1";

export type PaidOrderInput = {
  source: "erp" | "youzan";
  orderId: string; // ERP commerce_orders.id or Youzan tid
  linkedYouzanTid?: string | null; // ERP order imported from / mirrored to Youzan
  linkedErpOrderId?: string | null;
  customerId: string | null; // trusted binding only
  paymentVerified: boolean; // authoritative paid state, never client reported
  goodsPaidFen: number | null; // goods actually paid, shipping excluded
  discountDetailComplete: boolean;
  pointsCouponUsed: boolean | null; // null = unknown → hold
  paidAt: string | null;
};

const KEY = /^[A-Za-z0-9_.:-]{1,120}$/;

export function orderKey(source: "erp" | "youzan", id: string) {
  if (!KEY.test(id)) throw new Error("points_order_key_invalid");
  return `${source}:${id}`;
}

export type PaidFact = {
  p_canonical_key: string; p_alias_keys: string[]; p_customer_id: string; p_source: "erp" | "youzan";
  p_goods_paid_fen: number; p_discount_detail_complete: boolean; p_points_coupon_used: boolean | null;
  p_paid_at: string; p_rule_version: string;
};

export function buildPaidFact(o: PaidOrderInput): { ok: true; fact: PaidFact } | { ok: false; reason: string } {
  if (!o.customerId) return { ok: false, reason: "member_not_bound" };
  if (!o.paymentVerified || !o.paidAt) return { ok: false, reason: "payment_not_verified" };
  if (o.goodsPaidFen == null || !Number.isSafeInteger(o.goodsPaidFen) || o.goodsPaidFen < 0) {
    return { ok: false, reason: "goods_paid_invalid" };
  }
  // Canonical = Youzan tid when one exists, so an imported Youzan order never earns twice.
  const tid = o.source === "youzan" ? o.orderId : o.linkedYouzanTid ?? null;
  const erpId = o.source === "erp" ? o.orderId : o.linkedErpOrderId ?? null;
  const canonical = tid ? orderKey("youzan", tid) : orderKey("erp", erpId!);
  const aliases = [tid && erpId ? orderKey("erp", erpId) : null].filter((k): k is string => !!k && k !== canonical);
  return { ok: true, fact: {
    p_canonical_key: canonical, p_alias_keys: aliases, p_customer_id: o.customerId, p_source: o.source,
    p_goods_paid_fen: o.goodsPaidFen, p_discount_detail_complete: o.discountDetailComplete,
    p_points_coupon_used: o.pointsCouponUsed, p_paid_at: o.paidAt, p_rule_version: POINTS_EARNING_RULE_VERSION,
  } };
}
