import test from "node:test";
import assert from "node:assert/strict";
import { buildQuoteInput, parseShippingGroups, yuanToFen } from "./quote-input";

test("yuan amounts convert to integer fen without float drift", () => {
  assert.equal(yuanToFen(12.35), 1235);
  assert.equal(yuanToFen("0.07"), 7);
  assert.equal(yuanToFen(null), 0);
});

test("unusable courier snapshots yield null instead of a guess", () => {
  assert.equal(parseShippingGroups(null, new Set()), null);
  assert.equal(parseShippingGroups({ groups: [] }, new Set()), null);
  assert.equal(parseShippingGroups({ groups: [{ store_name: "温州店", shipping_fee_fen: 500 }] }, new Set()), null);
  assert.equal(parseShippingGroups({ groups: [{ location_id: "L1", shipping_fee_fen: 5.5 }] }, new Set()), null);
});

test("mapped snapshot marks shipped groups", () => {
  const groups = parseShippingGroups(
    { groups: [{ location_id: "L1", shipping_fee_fen: 500 }, { location_id: "L2", shipping_fee_fen: 0 }] },
    new Set(["L2"]),
  );
  assert.deepEqual(groups, [
    { location_id: "L1", shipping_fee_fen: 500, shipped: false },
    { location_id: "L2", shipping_fee_fen: 0, shipped: true },
  ]);
});

test("quote input carries integer fen and the caps through", () => {
  const input = buildQuoteInput({
    order: { total_amount: 120.5, shipping_fee: 10, courier_quote_snapshot: null },
    items: [{ id: "i1", location_id: "L1", quantity: 2, line_total: 110.5 }],
    shortage: { order_item_id: "i1", quantity: 1 },
    shippedLocationIds: new Set(),
    itemRefundedFen: 100,
    paymentRefundedFen: 200,
    groupOutstandingQuantity: 1,
  });
  assert.equal(input.paid_total_fen, 12050);
  assert.equal(input.paid_shipping_fen, 1000);
  assert.equal(input.items[0]!.line_total_fen, 11050);
  assert.equal(input.shipping_groups, null);
  assert.equal(input.item_refunded_fen, 100);
});
