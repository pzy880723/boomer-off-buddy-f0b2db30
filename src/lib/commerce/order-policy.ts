export const CHECKOUT_HOLD_MINUTES = 15;

export type PaymentStatus =
  "unpaid" | "paid" | "refund_pending" | "partially_refunded" | "refunded" | "payment_failed";

export type OrderStatus =
  | "pending_payment"
  | "confirmed"
  | "processing"
  | "completed"
  | "cancelled"
  | "after_sale"
  | "closed";

export type FulfillmentStatus =
  | "unallocated"
  | "allocated"
  | "picking"
  | "picked"
  | "packing"
  | "packed"
  | "handover_ready"
  | "handed_over"
  | "exception";

const FULFILLMENT_TRANSITIONS: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  unallocated: ["allocated", "exception"],
  allocated: ["picking", "exception"],
  picking: ["picked", "allocated", "exception"],
  picked: ["packing", "picking", "exception"],
  packing: ["packed", "picked", "exception"],
  packed: ["handover_ready", "packing", "exception"],
  handover_ready: ["handed_over", "packed", "exception"],
  handed_over: [],
  exception: ["allocated", "picking", "packing", "packed"],
};

export function checkoutHoldExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + CHECKOUT_HOLD_MINUTES * 60_000);
}

export function canTransitionFulfillment(from: FulfillmentStatus, to: FulfillmentStatus): boolean {
  return FULFILLMENT_TRANSITIONS[from].includes(to);
}

export function deriveOrderStatus(
  paymentStatus: PaymentStatus,
  fulfillmentStatuses: FulfillmentStatus[],
): OrderStatus {
  if (paymentStatus === "refunded") return "closed";
  if (paymentStatus === "refund_pending" || paymentStatus === "partially_refunded") {
    return "after_sale";
  }
  if (paymentStatus !== "paid") return "pending_payment";
  if (
    fulfillmentStatuses.length > 0 &&
    fulfillmentStatuses.every((status) => status === "handed_over")
  ) {
    return "completed";
  }
  return fulfillmentStatuses.length > 0 ? "processing" : "confirmed";
}

export function normalizeCourierChoice(raw: string): {
  provider: "sf" | "cainiao" | "platform";
  serviceCode: string;
} {
  const serviceCode = raw.trim().toUpperCase();
  if (serviceCode.startsWith("SF_")) return { provider: "sf", serviceCode };
  if (serviceCode.startsWith("CAINIAO_")) return { provider: "cainiao", serviceCode };
  if (serviceCode === "PLATFORM_RECOMMENDED") {
    return { provider: "platform", serviceCode };
  }
  throw new Error(`Unsupported courier service: ${raw}`);
}
