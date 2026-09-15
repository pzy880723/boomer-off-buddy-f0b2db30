/**
 * 把订单/快照/已退金额拼装成 computeShortageQuote 的输入（纯函数）。
 * 金额一律换成整数分；无法可靠映射的运费快照传 null（进入人工复核，不猜）。
 */
import type { QuoteInput, QuoteOrderItem, QuoteShippingGroup } from "./quote";

export function yuanToFen(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export type OrderItemRow = {
  id: string;
  location_id: string | null;
  quantity: number;
  line_total: number | string | null;
};

export type CourierSnapshot = {
  groups?: Array<{
    location_id?: string | null;
    store_name?: string | null;
    shipping_fee_fen?: number | null;
  }> | null;
} | null;

export function parseShippingGroups(
  snapshot: CourierSnapshot,
  shippedLocationIds: ReadonlySet<string>,
): QuoteShippingGroup[] | null {
  const groups = snapshot?.groups;
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const out: QuoteShippingGroup[] = [];
  for (const group of groups) {
    const locationId = group?.location_id;
    const fee = group?.shipping_fee_fen;
    // 缺 location_id 或非整数分运费 → 无法可靠映射，整份快照作废
    if (typeof locationId !== "string" || !locationId) return null;
    if (typeof fee !== "number" || !Number.isInteger(fee) || fee < 0) return null;
    out.push({ location_id: locationId, shipping_fee_fen: fee, shipped: shippedLocationIds.has(locationId) });
  }
  return out;
}

export function buildQuoteInput(args: {
  order: { total_amount: number | string | null; shipping_fee: number | string | null; courier_quote_snapshot: CourierSnapshot };
  items: OrderItemRow[];
  shortage: { order_item_id: string; quantity: number };
  shippedLocationIds: ReadonlySet<string>;
  itemRefundedFen: number;
  paymentRefundedFen: number;
  /** 同组其余行仍待履约数量合计（不含本次申报行）。 */
  groupOutstandingQuantity: number;
  /** 同组运费已被其它缺货预留/退掉 → 本次按 goods-only。 */
  groupShippingReserved?: boolean;
}): QuoteInput {
  const items: QuoteOrderItem[] = args.items.map((row) => ({
    id: row.id,
    location_id: row.location_id ?? "",
    quantity: row.quantity,
    line_total_fen: yuanToFen(row.line_total),
  }));
  return {
    items,
    paid_total_fen: yuanToFen(args.order.total_amount),
    paid_shipping_fen: yuanToFen(args.order.shipping_fee),
    shipping_groups: parseShippingGroups(args.order.courier_quote_snapshot, args.shippedLocationIds),
    shortage: args.shortage,
    item_refunded_fen: args.itemRefundedFen,
    payment_refunded_fen: args.paymentRefundedFen,
    group_outstanding_quantity: args.groupOutstandingQuantity,
    group_shipping_reserved: args.groupShippingReserved ?? false,
  };
}
