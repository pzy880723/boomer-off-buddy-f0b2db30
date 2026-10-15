import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPaidFact } from "./points-earning";
import { recordPaidOrderPoints } from "@/server/points-earning.server";

const base = { source: "erp" as const, orderId: "o1", customerId: "c", paymentVerified: true,
  goodsPaidFen: 12345, discountDetailComplete: true, pointsCouponUsed: false, paidAt: "2026-10-15T00:00:00Z" };

test("unbound member or unverified payment never produces a fact", () => {
  assert.equal(buildPaidFact({ ...base, customerId: null }).ok, false);
  assert.equal(buildPaidFact({ ...base, paymentVerified: false }).ok, false);
  assert.equal(buildPaidFact({ ...base, goodsPaidFen: -1 }).ok, false);
});
test("erp order mirrored from youzan uses the youzan tid as canonical key", () => {
  const a = buildPaidFact({ ...base, linkedYouzanTid: "E2026" });
  const b = buildPaidFact({ ...base, source: "youzan", orderId: "E2026", linkedErpOrderId: "o1" });
  assert.ok(a.ok && b.ok);
  assert.equal(a.fact.p_canonical_key, "youzan:E2026");
  assert.equal(b.fact.p_canonical_key, "youzan:E2026");
  assert.deepEqual(a.fact.p_alias_keys, ["erp:o1"]);
});
test("unknown points-coupon usage passes through as null so the DB holds it", () => {
  const r = buildPaidFact({ ...base, pointsCouponUsed: null });
  assert.ok(r.ok); assert.equal(r.fact.p_points_coupon_used, null);
});
test("env flag off: adapter never calls the database", async () => {
  delete process.env.POINTS_EARNING_ENABLED;
  let called = false;
  const r = await recordPaidOrderPoints(base, async () => { called = true; return { data: null, error: null }; });
  assert.equal(r.status, "disabled"); assert.equal(called, false);
});
