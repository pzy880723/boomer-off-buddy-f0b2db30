// Storefront order reference resolution.
// Accepts three caller-visible references and never leaks payment internals:
//   1. the order UUID (existing behaviour)
//   2. the shop order number (BO...)
//   3. the 32-hex WeChat merchant order number (commerce_payments.merchant_order_no)
// Every lookup is scoped to the authenticated customer; anything else resolves to null.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_NO_RE = /^BO[0-9A-Z]{6,30}$/;
const MERCHANT_ORDER_NO_RE = /^[0-9a-f]{32}$/i;

export type OrderReferenceKind = "uuid" | "order_no" | "merchant_order_no";

export function classifyOrderReference(reference: string): OrderReferenceKind | null {
  if (typeof reference !== "string") return null;
  const value = reference.trim();
  if (!value) return null;
  if (UUID_RE.test(value)) return "uuid";
  if (ORDER_NO_RE.test(value.toUpperCase()) && /^BO/i.test(value)) return "order_no";
  if (MERCHANT_ORDER_NO_RE.test(value)) return "merchant_order_no";
  return null;
}

export type OrderReferenceLookups = {
  findByOrderNo(orderNo: string, customerId: string): Promise<string | null>;
  findByMerchantOrderNo(merchantOrderNo: string, customerId: string): Promise<string | null>;
};

export async function resolveStorefrontOrderId(
  reference: string,
  customerId: string,
  lookups: OrderReferenceLookups,
): Promise<string | null> {
  const kind = classifyOrderReference(reference);
  if (!kind) return null;
  const value = reference.trim();
  if (kind === "uuid") return value;
  if (kind === "order_no") return await lookups.findByOrderNo(value.toUpperCase(), customerId);
  return await lookups.findByMerchantOrderNo(value.toLowerCase(), customerId);
}
