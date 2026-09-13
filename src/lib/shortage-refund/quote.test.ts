import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateByLargestRemainder,
  allocateItemPaidShares,
  allocateUnitShares,
  computeShortageQuote,
  type QuoteInput,
} from "./quote";

const items = [
  { id: "a", location_id: "L1", quantity: 2, line_total_fen: 3333 },
  { id: "b", location_id: "L2", quantity: 1, line_total_fen: 3334 },
];

function base(over: Partial<QuoteInput> = {}): QuoteInput {
  return {
    items,
    paid_total_fen: 7000, // 6667 商品 + 333 运费
    paid_shipping_fen: 333,
    shipping_groups: [
      { location_id: "L1", shipping_fee_fen: 200, shipped: false },
      { location_id: "L2", shipping_fee_fen: 133, shipped: false },
    ],
    shortage: { order_item_id: "a", quantity: 2 },
    item_refunded_fen: 0,
    payment_refunded_fen: 0,
    group_outstanding_quantity: 0,
    ...over,
  };
}

test("largest remainder keeps the integer total exact", () => {
  assert.deepEqual(allocateByLargestRemainder(100, [1, 1, 1]), [34, 33, 33]);
  assert.equal(allocateByLargestRemainder(6667, [3333, 3334]).reduce((a, b) => a + b, 0), 6667);
  assert.deepEqual(allocateByLargestRemainder(10, [0, 0]), [5, 5]);
});

test("item shares sum to the paid goods amount, unit shares sum to the line share", () => {
  const shares = allocateItemPaidShares(items, 6667);
  assert.equal((shares.get("a") ?? 0) + (shares.get("b") ?? 0), 6667);
  const units = allocateUnitShares(shares.get("a") ?? 0, 2);
  assert.equal(units.reduce((a, b) => a + b, 0), shares.get("a"));
});

test("uses paid allocation, not current price, and refunds the group shipping when the whole group is unshipped", () => {
  const q = computeShortageQuote(base());
  assert.equal(q.refund_goods_fen, 3333);
  assert.equal(q.refund_shipping_fen, 200);
  assert.equal(q.refund_total_fen, 3533);
  assert.equal(q.can_confirm, true);
  assert.deepEqual(q.blocked_reasons, []);
});

test("partial shortage never refunds shipping", () => {
  const q = computeShortageQuote(base({ shortage: { order_item_id: "a", quantity: 1 } }));
  assert.equal(q.refund_shipping_fen, 0);
  assert.equal(q.refund_goods_fen, 1667);
});

test("other outstanding lines in the same group block the shipping refund", () => {
  const q = computeShortageQuote(base({ group_outstanding_quantity: 1 }));
  assert.equal(q.refund_shipping_fen, 0);
  assert.equal(q.can_confirm, true);
});

test("already shipped group does not refund shipping", () => {
  const q = computeShortageQuote(
    base({
      shipping_groups: [
        { location_id: "L1", shipping_fee_fen: 200, shipped: true },
        { location_id: "L2", shipping_fee_fen: 133, shipped: false },
      ],
    }),
  );
  assert.equal(q.refund_shipping_fen, 0);
});

test("missing or unmapped shipping snapshot goes to manual review instead of guessing", () => {
  const missing = computeShortageQuote(base({ shipping_groups: null }));
  assert.equal(missing.refund_shipping_fen, 0);
  assert.equal(missing.can_confirm, false);
  assert.ok(missing.blocked_reasons.includes("shipping_snapshot_unavailable"));

  const unmapped = computeShortageQuote(
    base({ shipping_groups: [{ location_id: "LX", shipping_fee_fen: 200, shipped: false }] }),
  );
  assert.equal(unmapped.can_confirm, false);
  assert.ok(unmapped.blocked_reasons.includes("shipping_group_unmapped"));
});

test("item level and payment level caps clamp the amount and force manual review", () => {
  const itemCap = computeShortageQuote(base({ item_refunded_fen: 3000 }));
  assert.equal(itemCap.refund_goods_fen, 333);
  assert.ok(itemCap.blocked_reasons.includes("item_refund_cap_reached"));

  const paymentCap = computeShortageQuote(base({ payment_refunded_fen: 6900 }));
  assert.equal(paymentCap.refund_total_fen, 100);
  assert.ok(paymentCap.blocked_reasons.includes("payment_refund_cap_reached"));
  assert.equal(paymentCap.can_confirm, false);
});

test("quote_version is stable for the same input and changes when the amount changes", () => {
  assert.equal(computeShortageQuote(base()).quote_version, computeShortageQuote(base()).quote_version);
  assert.notEqual(
    computeShortageQuote(base()).quote_version,
    computeShortageQuote(base({ shortage: { order_item_id: "a", quantity: 1 } })).quote_version,
  );
});

test("unknown line or unusable paid amount never yields a refundable quote", () => {
  const unknown = computeShortageQuote(base({ shortage: { order_item_id: "zz", quantity: 1 } }));
  assert.equal(unknown.refund_total_fen, 0);
  assert.equal(unknown.can_confirm, false);
  const unpaid = computeShortageQuote(base({ paid_total_fen: 0, paid_shipping_fen: 0 }));
  assert.equal(unpaid.can_confirm, false);
});
