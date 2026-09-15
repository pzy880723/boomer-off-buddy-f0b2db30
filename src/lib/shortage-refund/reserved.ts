/**
 * 已退 + 预占金额汇总（纯函数）。
 *
 * 铁律：同一笔退款只能被计一次。
 * 退款意图一旦生成了真实退款记录（refund_id 或同一 after_sale_id 的退款行），
 * 该意图的预占已经由退款记录体现，绝不能再叠加一次。
 */

export type RefundRowLite = {
  id: string;
  after_sale_id: string | null;
  status: string;
  amount_fen: number;
};

export type IntentRowLite = {
  id: string;
  after_sale_id: string | null;
  refund_id: string | null;
  state: string;
  amount_fen: number;
};

/** 已取消的退款不占额度。 */
export function isLiveRefund(row: { status: string }): boolean {
  return row.status !== "cancelled";
}

/** 失败的意图不占额度。 */
export function isLiveIntent(row: { state: string }): boolean {
  return row.state !== "failed";
}

/**
 * 支付级 / 商品级通用：退款记录金额 + 尚未落成退款记录的意图金额。
 * 去重键：intent.refund_id 命中退款行，或 intent.after_sale_id 命中退款行的 after_sale_id。
 */
export function computeReservedFen(
  refunds: readonly RefundRowLite[],
  intents: readonly IntentRowLite[],
): number {
  const live = refunds.filter(isLiveRefund);
  const refundIds = new Set(live.map((r) => r.id));
  const refundAfterSaleIds = new Set(
    live.map((r) => r.after_sale_id).filter((v): v is string => !!v),
  );
  const refundsFen = live.reduce((sum, r) => sum + r.amount_fen, 0);
  const intentsFen = intents
    .filter(isLiveIntent)
    .filter((i) => !(i.refund_id && refundIds.has(i.refund_id)))
    .filter((i) => !(i.after_sale_id && refundAfterSaleIds.has(i.after_sale_id)))
    .reduce((sum, i) => sum + i.amount_fen, 0);
  return refundsFen + intentsFen;
}

/**
 * 同门店组「其余行仍待履约的数量」：原始数量扣掉已确认缺货 / 已退货的数量，
 * 不能用原始下单数量当作仍待发货。
 */
export function groupOutstandingQuantity(args: {
  items: readonly { id: string; location_id: string | null; quantity: number }[];
  locationId: string | null;
  excludeOrderItemId: string;
  /** 每个 order_item 已被缺货占用 / 已退的数量。 */
  settledQuantityByItem: ReadonlyMap<string, number>;
}): number {
  return args.items
    .filter((i) => (i.location_id ?? null) === args.locationId && i.id !== args.excludeOrderItemId)
    .reduce(
      (sum, i) => sum + Math.max(0, i.quantity - (args.settledQuantityByItem.get(i.id) ?? 0)),
      0,
    );
}
