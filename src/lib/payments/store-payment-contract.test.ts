import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";

const migrationsUrl = new URL("../../../supabase/migrations/", import.meta.url);
const migrationName = readdirSync(migrationsUrl).find((name) =>
  name.endsWith("_store_payment_subjects.sql"),
);

describe("store payment subject contract", () => {
  test("persists verified subjects, per-store payment codes, and immutable allocations", () => {
    assert.ok(migrationName, "store payment migration is required");
    const sql = readFileSync(new URL(migrationName!, migrationsUrl), "utf8");
    for (const table of [
      "payment_subjects",
      "payment_subject_applications",
      "store_payment_profiles",
      "commerce_payment_suborders",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE public\\.${table}`));
      assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
    }
    assert.match(sql, /location_id uuid NOT NULL UNIQUE/);
    assert.match(sql, /payment_code text NOT NULL UNIQUE/);
    assert.match(sql, /INSERT INTO public\.store_payment_profiles \(location_id\)/);
    assert.match(sql, /CREATE TRIGGER trg_ensure_store_payment_profile/);
    assert.match(sql, /settlement_subject_id/);
    assert.match(sql, /settlement_snapshot jsonb/);
    assert.doesNotMatch(sql, /api_v3_key|private_key|certificate_pem/i);
  });

  test("keeps management in ERP and exposes only a readiness-safe POS code endpoint", () => {
    const managementRoute = new URL("../../routes/shop-mgmt.payments.tsx", import.meta.url);
    const managementFunctions = new URL("../store-payments.functions.ts", import.meta.url);
    const posRoute = new URL("../../routes/api/public/pos/payment-code.ts", import.meta.url);
    assert.equal(existsSync(managementRoute), true);
    assert.equal(existsSync(managementFunctions), true);
    assert.equal(existsSync(posRoute), true);
    assert.match(readFileSync(managementFunctions, "utf8"), /super_admin/);
    assert.match(readFileSync(managementFunctions, "utf8"), /hq_operator/);
    assert.match(readFileSync(posRoute, "utf8"), /authenticatePosUser/);
    assert.match(readFileSync(posRoute, "utf8"), /ready_for_payment/);
  });
});
