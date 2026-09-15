import test from "node:test";
import assert from "node:assert/strict";
import { computeReservedFen, groupOutstandingQuantity } from "./reserved";

test("同一意图已生成退款记录时只占一次额度（不双算）", () => {
  const reserved = computeReservedFen(
    [{ id: "r1", after_sale_id: "as1", status: "succeeded", amount_fen: 1000 }],
    [{ id: "i1", after_sale_id: "as1", refund_id: "r1", state: "succeeded", amount_fen: 1000 }],
  );
  assert.equal(reserved, 1000);
});

test("仅靠 after_sale_id 关联也能去重（refund_id 尚未回写）", () => {
  const reserved = computeReservedFen(
    [{ id: "r1", after_sale_id: "as1", status: "processing", amount_fen: 500 }],
    [{ id: "i1", after_sale_id: "as1", refund_id: null, state: "processing", amount_fen: 500 }],
  );
  assert.equal(reserved, 500);
});

test("同一支付多次部分退款累加，尚未落成退款的意图另计", () => {
  const reserved = computeReservedFen(
    [
      { id: "r1", after_sale_id: "as1", status: "succeeded", amount_fen: 300 },
      { id: "r2", after_sale_id: "as2", status: "succeeded", amount_fen: 200 },
      { id: "r3", after_sale_id: "as3", status: "cancelled", amount_fen: 900 },
    ],
    [
      { id: "i1", after_sale_id: "as1", refund_id: "r1", state: "succeeded", amount_fen: 300 },
      { id: "i2", after_sale_id: "as9", refund_id: null, state: "queued", amount_fen: 150 },
      { id: "i3", after_sale_id: "as8", refund_id: null, state: "failed", amount_fen: 400 },
    ],
  );
  assert.equal(reserved, 300 + 200 + 150);
});

test("同组其余行的待履约数量要扣掉已确认缺货/已退的数量", () => {
  const items = [
    { id: "a", location_id: "L1", quantity: 3 },
    { id: "b", location_id: "L1", quantity: 2 },
    { id: "c", location_id: "L2", quantity: 5 },
  ];
  assert.equal(
    groupOutstandingQuantity({
      items,
      locationId: "L1",
      excludeOrderItemId: "a",
      settledQuantityByItem: new Map([["b", 2]]),
    }),
    0,
  );
  assert.equal(
    groupOutstandingQuantity({
      items,
      locationId: "L1",
      excludeOrderItemId: "a",
      settledQuantityByItem: new Map(),
    }),
    2,
  );
});
