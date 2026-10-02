import assert from "node:assert/strict";
import { test } from "node:test";
import { calculatePointsDiscountTotals, calculatePointsRedemption, moneyFen } from "./points-policy.ts";

const rules = {
  enabled: true, available_points: 10000, cap_rate: 0.15,
  points_per_unit: 10, unit_fen: 100, policy_version: 1, customer_active: true,
};
const totals = { subtotal: 100, eligible_total: 80, discount_total: 10, payable_total: 90 };
test("unconfigured rules never invent a conversion rate", () => {
  const result = calculatePointsRedemption(totals, 100, null);
  assert.equal(result.enabled, false);
  assert.equal(result.applied_points, 0);
  assert.equal(result.reason, "points_rule_not_configured");
});
test("cap is based on eligible remainder after other discounts, in whole conversion units", () => {
  const result = calculatePointsRedemption(totals, 200, rules);
  assert.equal(result.max_points, 100);
  assert.equal(result.applied_points, 100);
  assert.equal(result.discount_amount, 10);
  assert.equal(result.reason, "points_request_capped");
});
test("balance and whole units constrain redemption", () => {
  assert.equal(calculatePointsRedemption(totals, 19, rules).applied_points, 10);
  assert.equal(calculatePointsRedemption(totals, 100, { ...rules, available_points: 9 }).max_points, 0);
});
test("zero cap, inactive customer and missing units fail closed", () => {
  for (const change of [{ cap_rate: 0 }, { customer_active: false }, { points_per_unit: null }]) {
    assert.equal(calculatePointsRedemption(totals, 100, { ...rules, ...change }).enabled, false);
  }
});
test("rejects fractional, negative, overflow and nonfinite points or money", () => {
  for (const value of [-1, 1.1, NaN, Infinity, 2147483648]) {
    assert.throws(() => calculatePointsRedemption(totals, value, rules));
  }
  for (const value of [-1, NaN, Infinity, 100000000000]) assert.throws(() => moneyFen(value));
  assert.equal(moneyFen(0.29), 29);
  assert.equal(moneyFen(1.005), 101);
});
test("excluded goods and exhausted eligible subtotal give zero discount", () => {
  assert.equal(calculatePointsRedemption({ ...totals, eligible_total: 10 }, 100, rules).discount_amount, 0);
});
test("preview matches PostgreSQL rounding at half-fen boundaries", () => {
  const lines = [{ unit_price: 10.01, quantity: 3, discount_eligible: true }];
  assert.equal(calculatePointsDiscountTotals(lines,{ type: "amount", value: 1.005 }).discount_total,1.01);
  assert.equal(calculatePointsDiscountTotals(lines,{ type: "percentage", value: 50 }).discount_total,15.02);
  assert.equal(calculatePointsDiscountTotals(lines,{ type: "final_price", value: 1.005 }).payable_total,1);
  assert.throws(() => calculatePointsDiscountTotals([{ ...lines[0], unit_price: NaN }],{ type: "amount", value: 0 }));
});
