import type { DashboardDisplay, DashboardRange } from "./dashboard-view";
import { isYouzanPaidOrder, toFen } from "./store-targets/sales-window";

export type CommerceSale = {
  id: string;
  order_no: string;
  source_channel: string;
  paid_at: string | null;
  payment_status: string;
  order_status: string;
  currency: string;
  total_amount: number;
  items: Array<{ id: string; location_id: string; quantity: number; line_total: number }>;
  refunds: Array<{
    amount: number;
    status: string;
    after_sale: { order_item_id: string | null } | null;
  }>;
  pos_returns?: Array<{ status: string; location_id: string; refund_total: number }>;
};
export type YouzanSale = {
  tid: string;
  shop_id: string;
  pay_time: string | null;
  status: string | null;
  payment: number | null;
  total_fee: number | null;
  num: number | null;
  outer_transaction_no: string | null;
};

export function chooseDashboardScope(isHq: boolean, ids: string[], requested?: string): string {
  const scope = requested ?? (isHq ? "all" : ids[0]);
  if (!scope || (scope === "all" ? !isHq : !ids.includes(scope)))
    throw new Error("无权查看该门店经营数据");
  return scope;
}

function dayOf(ts: string) {
  return new Date(Date.parse(ts) + 8 * 3_600_000).toISOString().slice(0, 10);
}

// Allocate the paid total (including order-level discounts/shipping) without losing cents.
function allocations(order: CommerceSale): Map<string, number> {
  const weights = new Map<string, number>();
  for (const item of order.items)
    weights.set(item.location_id, (weights.get(item.location_id) ?? 0) + toFen(item.line_total));
  const sum = [...weights.values()].reduce((a, b) => a + b, 0);
  if (!sum) return new Map();
  const total = toFen(order.total_amount);
  const parts = [...weights].map(([id, weight]) => ({
    id,
    exact: (total * weight) / sum,
    amount: Math.floor((total * weight) / sum),
  }));
  let remaining = total - parts.reduce((a, b) => a + b.amount, 0);
  parts.sort((a, b) => b.exact - b.amount - (a.exact - a.amount) || a.id.localeCompare(b.id));
  for (const part of parts) {
    if (remaining-- > 0) part.amount++;
  }
  return new Map(parts.map((part) => [part.id, part.amount]));
}

export function aggregateSales(input: {
  range: DashboardRange;
  locationIds: string[];
  all: boolean;
  commerce: CommerceSale[];
  youzan: YouzanSale[];
  hasYouzan: boolean;
}) {
  const warnings = new Set<string>();
  const facts: Array<{
    id: string;
    date: string;
    channel: string;
    gross: number;
    refund: number | null;
    units: number | null;
  }> = [];
  const nativeOrderNos = new Set<string>();
  const seen = new Set<string>();
  for (const order of input.commerce) {
    if (
      order.source_channel === "youzan" ||
      !order.paid_at ||
      !["paid", "refund_pending", "partially_refunded", "refunded"].includes(
        order.payment_status,
      ) ||
      ["cancelled", "closed"].includes(order.order_status)
    )
      continue;
    if (seen.has(order.id)) continue;
    seen.add(order.id);
    if (order.currency !== "CNY") {
      warnings.add("存在非人民币订单，本页仅统计人民币。");
      continue;
    }
    const selected = input.all
      ? order.items
      : order.items.filter((item) => input.locationIds.includes(item.location_id));
    if (!input.all && !selected.length) continue;
    nativeOrderNos.add(order.order_no);
    const shares = allocations(order);
    const gross = input.all
      ? toFen(order.total_amount)
      : input.locationIds.reduce((sum, id) => sum + (shares.get(id) ?? 0), 0);
    let refund: number | null = 0;
    const succeeded = order.refunds.filter((row) => row.status === "succeeded");
    const posReturns = (order.pos_returns ?? []).filter((row) =>
      ["completed", "refunded"].includes(row.status),
    );
    const totalRefund = succeeded.reduce((sum, row) => sum + toFen(row.amount), 0);
    if (posReturns.length && succeeded.length) {
      refund = null;
      warnings.add("部分收银订单同时存在两类退款记录，需核对是否重复，净额暂不合计。");
    } else if (posReturns.length) {
      refund = posReturns.reduce(
        (sum, row) =>
          sum +
          (input.all || input.locationIds.includes(row.location_id) ? toFen(row.refund_total) : 0),
        0,
      );
    } else if (
      ["partially_refunded", "refunded"].includes(order.payment_status) &&
      !succeeded.length
    ) {
      refund = null;
      warnings.add("部分订单标为已退款，但缺少成功退款流水，净额待核对。");
    } else if (input.all) refund = totalRefund;
    else if (totalRefund === toFen(order.total_amount)) refund = gross;
    else
      for (const row of succeeded) {
        const item = order.items.find((item) => item.id === row.after_sale?.order_item_id);
        if (item) {
          if (input.locationIds.includes(item.location_id)) refund += toFen(row.amount);
        } else if (shares.size === 1) refund += toFen(row.amount);
        else {
          refund = null;
          warnings.add("跨店订单存在未关联商品的部分退款，门店净额待核对。");
          break;
        }
      }
    if (!order.items.length || (!input.all && !shares.size))
      warnings.add("部分订单缺少可分配的商品明细，件数或门店金额需核对。");
    facts.push({
      id: order.id,
      date: dayOf(order.paid_at),
      channel: order.source_channel,
      gross,
      refund,
      units: order.items.length ? selected.reduce((sum, item) => sum + item.quantity, 0) : null,
    });
  }
  const tids = new Map<string, string>();
  for (const order of input.youzan) {
    if (!isYouzanPaidOrder({ ...order, post_fee: null })) continue;
    if (order.outer_transaction_no && nativeOrderNos.has(order.outer_transaction_no)) continue;
    if (tids.has(order.tid)) {
      if (tids.get(order.tid) !== order.shop_id)
        warnings.add("存在跨店重复的有赞订单号，本页按订单号去重，门店归属需核对。");
      continue;
    }
    tids.set(order.tid, order.shop_id);
    facts.push({
      id: `youzan:${order.tid}`,
      date: dayOf(order.pay_time!),
      channel: "youzan",
      gross: toFen(order.payment ?? order.total_fee),
      refund: null,
      units: order.num,
    });
  }
  if (input.hasYouzan)
    warnings.add("有赞尚无可靠退款数据源；已知实收可查看，合计净销售额与客单价暂待核对。");
  if (facts.some((fact) => fact.units === null))
    warnings.add("部分订单未提供有效商品数量，售出件数显示待核对。");
  const selected = facts.filter(
    (fact) => fact.date >= input.range.start && fact.date <= input.range.end,
  );
  function summarize(rows: typeof facts, unknownNet: boolean) {
    const grossPaidFen = rows.reduce((sum, row) => sum + row.gross, 0);
    const netSalesFen =
      unknownNet || rows.some((row) => row.refund === null)
        ? null
        : rows.reduce((sum, row) => sum + row.gross - row.refund!, 0);
    return {
      grossPaidFen,
      netSalesFen,
      orders: rows.length,
      units: rows.some((row) => row.units === null)
        ? null
        : rows.reduce((sum, row) => sum + row.units!, 0),
      aovFen: netSalesFen === null ? null : rows.length ? Math.round(netSalesFen / rows.length) : 0,
    };
  }
  const channels = (
    [
      ["pos", "收银台"],
      ["storefront", "网店"],
      ["youzan", "有赞"],
      ["manual", "人工订单"],
    ] as const
  )
    .filter(([key]) => key !== "manual" || selected.some((row) => row.channel === key))
    .map(([key, label]) => ({
      key,
      label,
      ...summarize(
        selected.filter((row) => row.channel === key),
        key === "youzan" && input.hasYouzan,
      ),
    }));
  const trend: DashboardDisplay["trend"] = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(Date.parse(input.range.end) - (6 - i) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return {
      date,
      ...summarize(
        facts.filter((row) => row.date === date),
        input.hasYouzan,
      ),
    };
  });
  return {
    metrics: summarize(selected, input.hasYouzan),
    channels,
    trend,
    warnings: [...warnings],
  };
}
