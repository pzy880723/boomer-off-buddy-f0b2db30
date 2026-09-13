/**
 * 缺货退款报价（纯函数，无 IO）。
 *
 * 铁律：
 * - 一律整数分；按**订单实付**分摊，不使用当前售价。
 * - 分摊用最大余数法，尾差固定落在确定的行上，同一输入必得同一结果。
 * - 只有某门店组**全部未发货**才退该组未履约运费；部分缺货不退整单运费。
 * - 缺少可验证运费快照 / 身份映射 → 不猜，进入人工复核（can_confirm=false）。
 * - 商品级与支付级都有「已退 + 预占」并发上限，超出即封顶并转人工。
 */

export type QuoteOrderItem = {
  id: string;
  location_id: string;
  quantity: number;
  /** 该行的实付金额占比基数：行小计（整数分，已扣行级优惠）。 */
  line_total_fen: number;
};

export type QuoteShippingGroup = {
  location_id: string;
  shipping_fee_fen: number;
  /** 该门店组是否已有任何实物发出（已发货即不退该组运费）。 */
  shipped: boolean;
};

export type QuoteInput = {
  items: QuoteOrderItem[];
  /** 订单实付总额（含运费），整数分。 */
  paid_total_fen: number;
  /** 订单实付运费，整数分。 */
  paid_shipping_fen: number;
  /** 运费快照按门店组拆分；缺失或无法映射时传 null。 */
  shipping_groups: QuoteShippingGroup[] | null;
  /** 本次申报缺货的行与数量。 */
  shortage: { order_item_id: string; quantity: number };
  /** 该行历史已退 + 已预占（整数分）。 */
  item_refunded_fen: number;
  /** 该支付历史已退 + 已预占（整数分）。 */
  payment_refunded_fen: number;
  /** 同组其余行仍待履约的数量合计（不含本次申报行的剩余量）。 */
  group_outstanding_quantity: number;
};

export type QuoteResult = {
  refund_goods_fen: number;
  refund_shipping_fen: number;
  refund_total_fen: number;
  quote_version: string;
  can_confirm: boolean;
  /** 不能自助确认时的原因（转人工复核）。 */
  blocked_reasons: string[];
};

/** 最大余数法：把 total 按 weights 分摊为整数分，和恒等于 total。 */
export function allocateByLargestRemainder(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    // 无权重信息时均分，尾差落在最前面的行上（确定性）。
    const base = Math.floor(total / n);
    const out = new Array(n).fill(base);
    let rest = total - base * n;
    for (let i = 0; i < n && rest > 0; i++, rest--) out[i] += 1;
    return out;
  }
  const exact = weights.map((w) => (total * w) / sum);
  const floors = exact.map((v) => Math.floor(v));
  let rest = total - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    // 余数大者优先；完全相同则按行序，保证确定性
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < order.length && rest > 0; k++, rest--) floors[order[k]!.i] += 1;
  return floors;
}

/** 各订单行按实付分摊到的商品金额（整数分，合计 = 实付商品额）。 */
export function allocateItemPaidShares(
  items: QuoteOrderItem[],
  paidGoodsFen: number,
): Map<string, number> {
  const shares = allocateByLargestRemainder(
    paidGoodsFen,
    items.map((i) => i.line_total_fen),
  );
  return new Map(items.map((item, idx) => [item.id, shares[idx]!]));
}

/** 行内按件分摊（合计 = 该行分摊额）。 */
export function allocateUnitShares(itemShareFen: number, quantity: number): number[] {
  return allocateByLargestRemainder(itemShareFen, new Array(Math.max(quantity, 0)).fill(1));
}

function stableHash(input: string): string {
  // FNV-1a 32bit ×2（不同种子）拼接，纯函数、跨端一致、无依赖。
  const hashOne = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return `${hashOne(0x811c9dc5)}${hashOne(0x9e3779b9)}`;
}

export function computeShortageQuote(input: QuoteInput): QuoteResult {
  const blocked: string[] = [];
  const paidGoodsFen = input.paid_total_fen - input.paid_shipping_fen;
  const item = input.items.find((i) => i.id === input.shortage.order_item_id) ?? null;

  if (!item || paidGoodsFen < 0 || input.paid_total_fen <= 0) {
    return {
      refund_goods_fen: 0,
      refund_shipping_fen: 0,
      refund_total_fen: 0,
      quote_version: stableHash(JSON.stringify({ invalid: true, input })),
      can_confirm: false,
      blocked_reasons: [!item ? "order_item_not_found" : "paid_amount_unavailable"],
    };
  }

  const shares = allocateItemPaidShares(input.items, paidGoodsFen);
  const itemShare = shares.get(item.id) ?? 0;
  const units = allocateUnitShares(itemShare, item.quantity);
  const qty = Math.min(Math.max(input.shortage.quantity, 0), item.quantity);
  if (qty !== input.shortage.quantity) blocked.push("shortage_quantity_exceeds_line");
  // 取前 qty 件的分摊额（确定性，尾差固定）
  let goods = units.slice(0, qty).reduce((a, b) => a + b, 0);

  // 商品级上限：该行分摊额 - 已退/预占
  const itemRemaining = Math.max(itemShare - input.item_refunded_fen, 0);
  if (goods > itemRemaining) {
    goods = itemRemaining;
    blocked.push("item_refund_cap_reached");
  }

  // 运费：仅当该门店组全部未发货（组内无其他待履约数量、且该组未发货）才退该组运费
  let shipping = 0;
  if (input.shipping_groups === null) {
    blocked.push("shipping_snapshot_unavailable");
  } else {
    const group = input.shipping_groups.find((g) => g.location_id === item.location_id) ?? null;
    if (!group) {
      blocked.push("shipping_group_unmapped");
    } else if (
      !group.shipped &&
      input.group_outstanding_quantity === 0 &&
      qty === item.quantity
    ) {
      shipping = Math.max(group.shipping_fee_fen, 0);
    }
  }

  let total = goods + shipping;
  // 支付级上限
  const paymentRemaining = Math.max(input.paid_total_fen - input.payment_refunded_fen, 0);
  if (total > paymentRemaining) {
    total = paymentRemaining;
    shipping = Math.min(shipping, total);
    goods = total - shipping;
    blocked.push("payment_refund_cap_reached");
  }
  if (total <= 0) blocked.push("no_refundable_amount");

  const quote_version = stableHash(
    JSON.stringify({
      item: item.id,
      qty,
      goods,
      shipping,
      total,
      paid: input.paid_total_fen,
      paidShipping: input.paid_shipping_fen,
      itemRefunded: input.item_refunded_fen,
      paymentRefunded: input.payment_refunded_fen,
      lines: input.items.map((i) => [i.id, i.line_total_fen, i.quantity]),
    }),
  );

  return {
    refund_goods_fen: goods,
    refund_shipping_fen: shipping,
    refund_total_fen: total,
    quote_version,
    can_confirm: blocked.length === 0,
    blocked_reasons: blocked,
  };
}
