import test from "node:test";
import assert from "node:assert/strict";
import {
  ORDER_COUNT_KEYS,
  countOrdersByStatus,
  emptyOrderCounts,
  matchesStatusFilter,
  type OrderRow,
} from "./storefront-order-list.server";

function order(partial: Partial<OrderRow> & { id: string }): OrderRow {
  return {
    order_no: partial.id,
    order_status: "pending_payment",
    payment_status: "unpaid",
    total_amount: 10,
    created_at: "2026-09-14T00:00:00Z",
    ...partial,
  } as OrderRow;
}

const unpaid = order({ id: "a" });
const paidUnshipped = order({
  id: "b",
  order_status: "confirmed",
  payment_status: "paid",
  items: [{ location_id: "L1" } as never],
  fulfillments: [{ location_id: "L1", status: "picking" }],
});
const paidPartlyShipped = order({
  id: "c",
  order_status: "processing",
  payment_status: "paid",
  items: [{ location_id: "L1" } as never, { location_id: "L2" } as never],
  fulfillments: [
    { location_id: "L1", status: "handed_over" },
    { location_id: "L2", status: "packing" },
  ],
});
const shipped = order({
  id: "d",
  order_status: "processing",
  payment_status: "paid",
  items: [{ location_id: "L1" } as never],
  fulfillments: [{ location_id: "L1", status: "handed_over" }],
});
const completed = order({ id: "e", order_status: "completed", payment_status: "paid" });
const cancelled = order({ id: "f", order_status: "cancelled", payment_status: "unpaid" });
const closed = order({ id: "g", order_status: "closed", payment_status: "paid" });
const refunding = order({ id: "h", order_status: "processing", payment_status: "refund_pending" });
const refunded = order({ id: "i", order_status: "processing", payment_status: "refunded" });
const partiallyRefunded = order({
  id: "j",
  order_status: "processing",
  payment_status: "partially_refunded",
});

test("四个角标口径：未付款/待发货/待收货/已完成", () => {
  const counts = countOrdersByStatus([
    unpaid,
    paidUnshipped,
    paidPartlyShipped,
    shipped,
    completed,
  ]);
  assert.deepEqual(counts, {
    pending_payment: 1,
    // 部分发货仍计入待发货，与列表 status=paid 的结果一致
    awaiting_shipment: 2,
    awaiting_receipt: 1,
    completed: 1,
  });
});

test("退款 / 关闭 / 取消一律不计入任何角标", () => {
  const counts = countOrdersByStatus([cancelled, closed, refunding, refunded, partiallyRefunded]);
  assert.deepEqual(counts, emptyOrderCounts());
  assert.deepEqual(emptyOrderCounts(), {
    pending_payment: 0,
    awaiting_shipment: 0,
    awaiting_receipt: 0,
    completed: 0,
  });
});

test("计数与列表筛选逐单一致：任何订单最多命中一个角标", () => {
  const rows = [
    unpaid,
    paidUnshipped,
    paidPartlyShipped,
    shipped,
    completed,
    cancelled,
    closed,
    refunding,
    refunded,
    partiallyRefunded,
  ];
  const counts = countOrdersByStatus(rows);
  const listStatus = {
    pending_payment: "pending_payment",
    awaiting_shipment: "paid",
    awaiting_receipt: "shipped",
    completed: "completed",
  } as const;
  for (const key of ORDER_COUNT_KEYS) {
    const viaList = rows.filter((row) => matchesStatusFilter(row, listStatus[key])).length;
    assert.equal(counts[key], viaList, key);
  }
  for (const row of rows) {
    const hits = ORDER_COUNT_KEYS.filter(
      (key) => countOrdersByStatus([row])[key] === 1,
    ).length;
    assert.ok(hits <= 1, `${row.id} 命中了多个角标`);
  }
});

test("计数全部为非负整数", () => {
  const counts = countOrdersByStatus([]);
  for (const key of ORDER_COUNT_KEYS) {
    assert.ok(Number.isInteger(counts[key]) && counts[key] >= 0);
  }
});

test("未付款但订单已取消不计 pending_payment", () => {
  assert.equal(countOrdersByStatus([cancelled]).pending_payment, 0);
});
