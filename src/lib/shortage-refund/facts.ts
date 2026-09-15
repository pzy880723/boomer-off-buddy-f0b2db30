/**
 * 缺货报价的**唯一**事实层（纯函数，无 IO）。
 *
 * ERP 新报缺货与旧单读时补报价必须走同一条路径：同样的已退/预占去重、
 * 同样的商品级上限、同样的「同组待履约数量」口径、同样的运费防重。
 *
 * 铁律：
 * - 已退 + 预占按 refund_id / after_sale_id 去重（computeReservedFen）。
 * - 商品级上限用该行自身真实已退 + 预占，绝不写死 0。
 * - 「同组其余行待履约数量」只扣**真正已处理**的缺货数量：
 *   待客户确认 / 已驳回 / 已撤回的兄弟缺货不算已处理，
 *   否则两条待确认缺货会互相认为对方已处理，各自都退一次整组运费。
 * - 同组已有其它缺货预留/退掉了该组运费 → 本次一律按 goods-only 报价。
 */
import { computeShortageQuote, type QuoteResult } from "./quote";
import { buildQuoteInput, type CourierSnapshot, type OrderItemRow } from "./quote-input";
import { computeReservedFen, type IntentRowLite, type RefundRowLite } from "./reserved";

export type ShortageSiblingRow = {
  id: string;
  order_item_id: string | null;
  location_id: string | null;
  quantity: number;
  status: string;
  refund_state: string;
  refund_intent_id: string | null;
  refund_shipping_fen: number | null;
};

export type QuoteFacts = {
  order: {
    total_amount: number | string | null;
    shipping_fee: number | string | null;
    courier_quote_snapshot: CourierSnapshot;
  };
  items: OrderItemRow[];
  /** 已有实物发出的门店组。 */
  shippedLocationIds: ReadonlySet<string>;
  refunds: RefundRowLite[];
  intents: IntentRowLite[];
  /** after_sale_id → order_item_id，用于把退款归到具体商品行。 */
  afterSaleItemById: ReadonlyMap<string, string | null>;
  /** 本订单全部缺货行（含本次；新报缺货时不含本次）。 */
  shortages: ShortageSiblingRow[];
};

export type QuoteTarget = {
  /** 旧单补报价时为该缺货 id；ERP 新报缺货时为 null。 */
  shortageId: string | null;
  orderItemId: string;
  locationId: string | null;
  quantity: number;
};

/** 已被驳回 / 撤回的缺货不占任何额度。 */
export function isLiveShortage(row: { status: string }): boolean {
  return row.status !== "withdrawn" && row.status !== "customer_cancelled";
}

/**
 * 「真正已处理」= 已经生成退款意图或客户已接受、或退款流程已在跑。
 * 仅待客户确认（pending_customer / awaiting_confirmation）不算已处理。
 */
export function isProcessedShortage(row: ShortageSiblingRow): boolean {
  if (!isLiveShortage(row)) return false;
  if (row.refund_intent_id) return true;
  if (row.status === "customer_accepted") return true;
  return ["queued", "processing", "succeeded", "refund_pending", "refund_completed"].includes(
    row.refund_state,
  );
}

/** 同组是否已有其它缺货预留 / 退掉了该组运费。 */
export function groupShippingReserved(
  shortages: readonly ShortageSiblingRow[],
  target: QuoteTarget,
): boolean {
  return shortages.some(
    (s) =>
      s.id !== target.shortageId &&
      isLiveShortage(s) &&
      (s.location_id ?? null) === (target.locationId ?? null) &&
      (s.refund_shipping_fen ?? 0) > 0 &&
      isProcessedShortage(s),
  );
}

export function computeQuoteFromFacts(facts: QuoteFacts, target: QuoteTarget): QuoteResult {
  const belongsToItem = (afterSaleId: string | null, itemId: string) =>
    !!afterSaleId && facts.afterSaleItemById.get(afterSaleId) === itemId;

  const paymentRefundedFen = computeReservedFen(facts.refunds, facts.intents);
  const itemRefundedFen = computeReservedFen(
    facts.refunds.filter((r) => belongsToItem(r.after_sale_id, target.orderItemId)),
    facts.intents.filter((i) => belongsToItem(i.after_sale_id, target.orderItemId)),
  );

  // 仅扣真正已处理的缺货数量
  const processedByItem = new Map<string, number>();
  for (const s of facts.shortages) {
    if (!s.order_item_id || s.id === target.shortageId) continue;
    if (!isProcessedShortage(s)) continue;
    processedByItem.set(
      s.order_item_id,
      (processedByItem.get(s.order_item_id) ?? 0) + Math.max(0, s.quantity),
    );
  }
  const groupOutstanding = facts.items
    .filter(
      (i) => (i.location_id ?? null) === (target.locationId ?? null) && i.id !== target.orderItemId,
    )
    .reduce((sum, i) => sum + Math.max(0, i.quantity - (processedByItem.get(i.id) ?? 0)), 0);

  return computeShortageQuote(
    buildQuoteInput({
      order: facts.order,
      items: facts.items,
      shortage: { order_item_id: target.orderItemId, quantity: target.quantity },
      shippedLocationIds: facts.shippedLocationIds,
      itemRefundedFen,
      paymentRefundedFen,
      groupOutstandingQuantity: groupOutstanding,
      groupShippingReserved: groupShippingReserved(facts.shortages, target),
    }),
  );
}
