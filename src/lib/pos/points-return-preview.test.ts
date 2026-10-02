import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calculatePointsReturnPreview } from "./points-return-preview.ts";

const item = {
  id: "item", sku_id: "sku", title_snapshot: "Test", quantity: 3,
  line_total: "29.03", epc: null, discount_snapshot: { points_allocated: 5 },
};
const request = [{ order_item_id: "item", quantity: 1 }];
const prior = (status: string, quantity = 1, completed_at: string | null = null) => ({
  order_item_id: "item", quantity, sale_return: { status, completed_at },
});

test("points previews use cumulative fen and frozen allocated points after refunded rows", () => {
  const first = calculatePointsReturnPreview(true, request, [item], []);
  const second = calculatePointsReturnPreview(true, request, [item], [prior("refunded")]);
  const last = calculatePointsReturnPreview(true, request, [item], [prior("refunded", 2)]);
  assert.deepEqual([first.refund_total, second.refund_total, last.refund_total], [9.67, 9.68, 9.68]);
  assert.deepEqual([first.points_restored, second.points_restored, last.points_restored], [1, 2, 2]);
  assert.equal(second.lines[0].points_restored, 2);
});

test("history status inclusion matches the refund transaction", () => {
  for (const status of ["pending", "refund_pending", "refunded", "inspection_pending", "completed"]) {
    assert.equal(calculatePointsReturnPreview(true, request, [item], [prior(status)]).refund_total, 9.68);
  }
  assert.equal(calculatePointsReturnPreview(true, request, [item], [prior("rejected")]).refund_total, 9.67);
  assert.equal(calculatePointsReturnPreview(true, request, [item], [prior("rejected", 1, "2026-10-03")]).refund_total, 9.68);
});

test("points preview rejects over-return and duplicate line requests", () => {
  assert.throws(() => calculatePointsReturnPreview(true, request, [item], [prior("refunded", 3)]), /invalid_return_quantity/);
  assert.throws(() => calculatePointsReturnPreview(true, [...request, ...request], [item], []), /invalid_return_quantity/);
  assert.throws(() => calculatePointsReturnPreview(true, request, [], []), /invalid_return_quantity/);
});

test("zero-points legacy preview ignores cumulative history and retains prior rounding", () => {
  const result = calculatePointsReturnPreview(false, request, [item], [prior("refunded", 3)]);
  assert.equal(result.refund_total, 9.68);
  assert.equal(result.points_restored, 0);
  assert.equal(result.lines[0].points_restored, 0);
});

test("mixed eligible lines add cash and points without giving excluded goods points", () => {
  const excluded = { ...item, id: "excluded", quantity: 1, line_total: "10.00", discount_snapshot: {} };
  const result = calculatePointsReturnPreview(true,
    [...request, { order_item_id: "excluded", quantity: 1 }], [item, excluded], [prior("refunded")]);
  assert.equal(result.refund_total, 19.68);
  assert.equal(result.points_restored, 2);
});

test("large-value cumulative multiplication remains integer-exact", () => {
  const expensive = { ...item, quantity: 999, line_total: "9999999999.99", discount_snapshot: { points_allocated: 2147483647 } };
  const result = calculatePointsReturnPreview(true, request, [expensive], [prior("refunded", 998)]);
  assert.equal(result.refund_total, Number(999999999999n - 999999999999n * 998n / 999n) / 100);
  assert.equal(result.points_restored, Number(2147483647n - 2147483647n * 998n / 999n));
});

test("invalid points snapshots fail closed", () => {
  for (const points of [-1, 0.5, NaN, Infinity]) {
    assert.throws(() => calculatePointsReturnPreview(true, request,
      [{ ...item, discount_snapshot: { points_allocated: points } }], []));
  }
});

test("route fetches order-scoped paginated history only for points orders", () => {
  const source = readFileSync(new URL("../../routes/api/public/pos/orders.$id.returns.preview.ts", import.meta.url), "utf8");
  assert.match(source, /benefit_snapshot/);
  assert.match(source, /sale_return:pos_returns!inner\(order_id,status,completed_at\)/);
  assert.match(source, /\.eq\("sale_return.order_id", params.id\)/);
  assert.match(source, /\.range\(/);
  assert.match(source, /calculatePointsReturnPreview\(/);
});
