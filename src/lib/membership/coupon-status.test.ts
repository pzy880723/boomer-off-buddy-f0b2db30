import { test } from "node:test";
import assert from "node:assert/strict";
import { mapMembershipCoupon } from "./coupon-status";

const now = Date.parse("2026-10-17T00:00:00Z");
const base = { id: "c1", code: "X", name: "满49.9减5", value: 5, min_spend: 49.9, created_at: "2026-10-01T00:00:00Z",
  starts_at: null, expires_at: "2026-12-31T00:00:00Z", metadata: {} };

test("cancelled coupon that has not expired is never usable", () => {
  const c = mapMembershipCoupon({ ...base, status: "cancelled" }, now);
  assert.equal(c.status, "void");
  assert.equal(c.usable, false);
});
test("active unexpired coupon is usable", () => {
  const c = mapMembershipCoupon({ ...base, status: "active" }, now);
  assert.equal(c.status, "available");
  assert.equal(c.usable, true);
});
test("active but past expiry shows expired", () => {
  const c = mapMembershipCoupon({ ...base, status: "active", expires_at: "2026-10-01T00:00:00Z" }, now);
  assert.equal(c.status, "expired"); assert.equal(c.usable, false);
});
test("used, frozen/reserved and unknown statuses are not usable", () => {
  assert.equal(mapMembershipCoupon({ ...base, status: "used" }, now).status, "used");
  assert.equal(mapMembershipCoupon({ ...base, status: "reserved" }, now).status, "frozen");
  assert.equal(mapMembershipCoupon({ ...base, status: "weird" }, now).usable, false);
});
test("not yet started is not usable", () => {
  const c = mapMembershipCoupon({ ...base, status: "active", starts_at: "2026-11-01T00:00:00Z" }, now);
  assert.equal(c.usable, false); assert.equal(c.status, "not_started");
});
