import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { calculatePointsRedemption } from "./points-policy.ts";

test("remove plan caps without changing conversion, activation or other benefits", async () => {
  const sql = await readFile(new URL("../../../supabase/migrations/20261003131000_remove_membership_points_caps.sql", import.meta.url), "utf8");
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE commerce_membership_plans (
      code text PRIMARY KEY, tier_code text, points_redemption_cap_rate numeric(6,4) DEFAULT 0,
      policy_version integer DEFAULT 1, updated_at timestamptz DEFAULT now(),
      points_redemption_enabled boolean, points_redemption_points_per_unit integer,
      points_redemption_unit_fen integer, benefit_rules jsonb DEFAULT '{}'
    );
    INSERT INTO commerce_membership_plans(code,tier_code,points_redemption_cap_rate,points_redemption_enabled)
      VALUES ('free','free',0,false),('explorer_monthly','explorer',0.15,false),('explorer_annual','explorer',0.15,true);
    UPDATE commerce_membership_plans SET points_redemption_points_per_unit=17,
      points_redemption_unit_fen=23, benefit_rules='{"discount":0.95}' WHERE code='explorer_annual';`);
    const before = (await db.query("SELECT * FROM commerce_membership_plans ORDER BY code")).rows;
    await db.exec(sql);
    const after = (await db.query("SELECT * FROM commerce_membership_plans ORDER BY code")).rows;
    for (let i = 0; i < after.length; i++) {
      assert.equal(Number(after[i].points_redemption_cap_rate), 1);
      assert.equal(after[i].policy_version, 2);
      for (const key of ["points_redemption_enabled", "points_redemption_points_per_unit", "points_redemption_unit_fen", "benefit_rules"]) {
        assert.deepEqual(after[i][key], before[i][key]);
      }
    }
    await db.exec(sql);
    assert.deepEqual((await db.query("SELECT * FROM commerce_membership_plans ORDER BY code")).rows, after);
  } finally {
    await db.close();
  }
});

test("100 percent policy permits more than 15 percent but respects balance and eligible amount", () => {
  const totals = { subtotal: 100, eligible_total: 80, discount_total: 10, payable_total: 90 };
  const rules = { enabled: true, customer_active: true, available_points: 10000,
    cap_rate: 1, points_per_unit: 10, unit_fen: 100, policy_version: 2 };
  assert.equal(calculatePointsRedemption(totals, 10000, rules).discount_amount, 70);
  assert.equal(calculatePointsRedemption(totals, 10000, { ...rules, available_points: 23 }).applied_points, 20);
  assert.equal(calculatePointsRedemption({ ...totals, eligible_total: 100 }, 10000, rules).discount_amount, 89);
  assert.equal(calculatePointsRedemption(totals, 10000, { ...rules, enabled: false }).applied_points, 0);
});
