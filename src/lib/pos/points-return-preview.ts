import { moneyFen } from "./points-policy.ts";

export type PointsReturnItem = {
  id: string;
  sku_id: string;
  title_snapshot: string;
  quantity: number;
  line_total: number | string;
  epc: string | null;
  discount_snapshot?: { points_allocated?: number | string | null } | null;
};

export type PointsReturnHistory = {
  order_item_id: string;
  quantity: number;
  sale_return: { status: string; completed_at: string | null };
};

export function calculatePointsReturnPreview(
  pointsOrder: boolean,
  requests: Array<{ order_item_id: string; quantity: number }>,
  items: PointsReturnItem[],
  history: PointsReturnHistory[],
) {
  const itemMap = new Map(items.map((item) => [item.id, item]));
  const previous = new Map<string, number>();
  if (pointsOrder) {
    for (const row of history) {
      // Match pos_complete_return, including completed returns later marked rejected.
      if (row.sale_return.status === "rejected" && row.sale_return.completed_at === null) continue;
      if (!Number.isSafeInteger(row.quantity) || row.quantity < 1) throw new Error("invalid_return_quantity");
      previous.set(row.order_item_id, (previous.get(row.order_item_id) ?? 0) + row.quantity);
    }
  }
  const seen = new Set<string>();
  let refundTotal = 0;
  let refundFen = 0;
  let pointsRestored = 0;
  const lines = requests.map((request) => {
    const item = itemMap.get(request.order_item_id);
    if (!item || !Number.isSafeInteger(item.quantity) || item.quantity < 1 ||
      !Number.isSafeInteger(request.quantity) || request.quantity < 1 || request.quantity > item.quantity) {
      throw new Error("invalid_return_quantity");
    }
    let refundAmount: number;
    let linePoints = 0;
    if (pointsOrder) {
      const returned = previous.get(item.id) ?? 0;
      if (seen.has(item.id) || !Number.isSafeInteger(returned) || returned + request.quantity > item.quantity) {
        throw new Error("invalid_return_quantity");
      }
      seen.add(item.id);
      const allocated = Number(item.discount_snapshot?.points_allocated ?? 0);
      if (!Number.isSafeInteger(allocated) || allocated < 0) throw new Error("invalid_return_snapshot");
      const cumulativeDifference = (total: number) => Number(
        BigInt(total) * BigInt(returned + request.quantity) / BigInt(item.quantity) -
        BigInt(total) * BigInt(returned) / BigInt(item.quantity),
      );
      const lineFen = cumulativeDifference(moneyFen(Number(item.line_total)));
      linePoints = cumulativeDifference(allocated);
      refundFen += lineFen;
      refundAmount = lineFen / 100;
    } else {
      // Preserve legacy independent rounding and quantity validation for zero-points orders.
      refundAmount = Math.round(Number(item.line_total) / item.quantity * request.quantity * 100) / 100;
    }
    refundTotal += refundAmount;
    pointsRestored += linePoints;
    return {
      ...request, sku_id: item.sku_id, title: item.title_snapshot,
      refund_amount: refundAmount, points_restored: linePoints,
      inspection_required: Boolean(item.epc),
    };
  });
  return {
    lines, refund_total: pointsOrder ? refundFen / 100 : Math.round(refundTotal * 100) / 100,
    points_restored: pointsRestored,
  };
}
