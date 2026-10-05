import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, after } from "node:test";
import { calculatePointsRedemption } from "./points-policy.ts";

// User-confirmed 2026-10-05: 100 points = 1 yuan. unit_fen is FEN, so 100:100 (not 100:1).
const rules = {
  enabled: true, available_points: 3000, cap_rate: 1,
  points_per_unit: 100, unit_fen: 100, policy_version: 3, customer_active: true,
};
const big = { subtotal: 100, eligible_total: 100, discount_total: 0, payable_total: 100 };

test("3000 points = 3000 fen = 30 yuan (100:100, not 100:1)", () => {
  const r = calculatePointsRedemption(big, 3000, rules);
  assert.equal(r.applied_points, 3000);
  assert.equal(r.discount_amount, 30);
  assert.notEqual(r.discount_amount, 0.3);
});
test("insufficient balance caps at whole 100-point units", () => {
  const r = calculatePointsRedemption(big, 3000, { ...rules, available_points: 1250 });
  assert.equal(r.max_points, 1200);
  assert.equal(r.applied_points, 1200);
  assert.equal(r.discount_amount, 12);
  assert.equal(r.reason, "points_request_capped");
});
test("insufficient payable keeps 1 fen payable and floors to whole yuan", () => {
  const r = calculatePointsRedemption({ subtotal: 20.5, eligible_total: 20.5, discount_total: 0, payable_total: 20.5 }, 3000, rules);
  assert.equal(r.max_points, 2000);
  assert.equal(r.discount_amount, 20);
  const tiny = calculatePointsRedemption({ subtotal: 1, eligible_total: 1, discount_total: 0, payable_total: 1 }, 3000, rules);
  assert.equal(tiny.applied_points, 0);
  assert.equal(tiny.reason, "points_unavailable");
});
test("cap_rate=1 means no extra percentage cap beyond eligible-after-discount", () => {
  const r = calculatePointsRedemption({ subtotal: 100, eligible_total: 100, discount_total: 80, payable_total: 20 }, 3000, rules);
  assert.equal(r.max_points, 1900);
});
test("zero request applies nothing; negative/fractional rejected; partial units floor down", () => {
  assert.equal(calculatePointsRedemption(big, 0, rules).applied_points, 0);
  assert.throws(() => calculatePointsRedemption(big, -100, rules));
  assert.throws(() => calculatePointsRedemption(big, 150.5, rules));
  const r = calculatePointsRedemption(big, 199, rules);
  assert.equal(r.applied_points, 100);
  assert.equal(r.discount_amount, 1);
});

const { PGlite } = await import("@electric-sql/pglite");
const db = new PGlite();
after(() => db.close());
test("real pos_points_rules returns 100/100, cap 1, enabled unchanged after the rate migration", async () => {
  const root = new URL("../../../", import.meta.url);
  await db.exec(await readFile(new URL("tests/sql/pos-points-fixture.sql", root), "utf8"));
  const mig = await readFile(new URL("supabase/migrations/20261002174301_pos_points_redemption.sql", root), "utf8");
  const start = mig.indexOf("CREATE OR REPLACE FUNCTION public.pos_points_rules(");
  await db.exec(`ALTER TABLE commerce_membership_plans
    ADD COLUMN points_redemption_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN points_redemption_points_per_unit integer CHECK (points_redemption_points_per_unit > 0),
    ADD COLUMN points_redemption_unit_fen integer CHECK (points_redemption_unit_fen > 0),
    ADD COLUMN updated_at timestamptz DEFAULT now();`);
  await db.exec(mig.slice(start, mig.indexOf("$$;", start) + 3));
  await db.exec(`
    CREATE TABLE IF NOT EXISTS public.pos_customer_wallets(customer_id uuid PRIMARY KEY, points integer);
    INSERT INTO commerce_customers VALUES ('00000000-0000-0000-0000-000000000002','active');
    INSERT INTO pos_customer_wallets(customer_id,points) VALUES ('00000000-0000-0000-0000-000000000002',3000);
    INSERT INTO commerce_membership_plans(id,code,tier_code,points_redemption_cap_rate) VALUES
      ('00000000-0000-0000-0000-000000000007','free','free',1),
      ('00000000-0000-0000-0000-000000000008','explorer_monthly','explorer',1),
      ('00000000-0000-0000-0000-000000000009','other_plan','explorer',0.5);`);
  await db.exec(await readFile(new URL("tests/sql/membership-points-rate-100.sql", root), "utf8"));
  const res = await db.query<{ r: Record<string, unknown> }>(
    "SELECT public.pos_points_rules('00000000-0000-0000-0000-000000000002') r");
  const r = res.rows[0].r;
  assert.equal(r.points_per_unit, 100);
  assert.equal(r.unit_fen, 100);
  assert.equal(Number(r.cap_rate), 1);
  assert.equal(r.enabled, false);
  assert.equal(r.available_points, 3000);
  const other = await db.query<{ p: number | null }>(
    "SELECT points_redemption_points_per_unit p FROM commerce_membership_plans WHERE code='other_plan'");
  assert.equal(other.rows[0].p, null);
});
