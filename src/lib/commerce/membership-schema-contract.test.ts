import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const migrationPath = new URL(
  "../../../supabase/migrations/20260817120000_commerce_membership_core.sql",
  import.meta.url,
);
const rpcSecurityMigrationPath = new URL(
  "../../../supabase/migrations/20260817130000_secure_membership_quota_rpc.sql",
  import.meta.url,
);
const apiRoleSecurityMigrationPath = new URL(
  "../../../supabase/migrations/20260817130100_revoke_quota_rpc_from_api_roles.sql",
  import.meta.url,
);

describe("commerce membership core schema", () => {
  test("keeps ERP as the sole membership source of truth", () => {
    const migration = readFileSync(migrationPath, "utf8");

    for (const table of [
      "commerce_membership_plans",
      "commerce_membership_orders",
      "commerce_membership_entitlements",
      "commerce_recognition_usage_daily",
      "commerce_recognition_usage_requests",
      "commerce_points_ledger",
      "commerce_coupon_definitions",
      "commerce_member_code_sessions",
      "commerce_consumption_records",
    ]) {
      assert.match(migration, new RegExp(`CREATE TABLE public\\.${table}`, "i"));
    }

    assert.match(
      migration,
      /customer_id uuid NOT NULL REFERENCES public\.commerce_customers\(id\)/i,
    );
    assert.match(
      migration,
      /ALTER TABLE public\.pos_customer_wallets[\s\S]*ADD COLUMN IF NOT EXISTS membership_plan_code/i,
    );
    assert.match(
      migration,
      /ALTER TABLE public\.pos_customer_coupons[\s\S]*ADD COLUMN IF NOT EXISTS definition_id/i,
    );
  });

  test("protects mutable balances and quotas with idempotency keys", () => {
    const migration = readFileSync(migrationPath, "utf8");

    assert.match(
      migration,
      /commerce_membership_orders[\s\S]*idempotency_key text NOT NULL[\s\S]*UNIQUE \(customer_id, idempotency_key\)/i,
    );
    assert.match(
      migration,
      /commerce_recognition_usage_requests[\s\S]*request_id text NOT NULL UNIQUE/i,
    );
    assert.match(migration, /commerce_points_ledger[\s\S]*idempotency_key text NOT NULL UNIQUE/i);
    assert.match(
      migration,
      /commerce_consumption_records[\s\S]*idempotency_key text NOT NULL UNIQUE/i,
    );
  });

  test("seeds the approved free and explorer policy versions", () => {
    const migration = readFileSync(migrationPath, "utf8");

    assert.match(migration, /'free'[\s\S]*5[\s\S]*1\.0000/i);
    assert.match(migration, /'explorer'[\s\S]*30[\s\S]*0\.9500[\s\S]*1\.2000[\s\S]*0\.1500/i);
  });

  test("reserves recognition quota atomically and idempotently", () => {
    const migration = readFileSync(migrationPath, "utf8");

    assert.match(
      migration,
      /CREATE OR REPLACE FUNCTION public\.commerce_reserve_recognition_quota/i,
    );
    assert.match(migration, /ON CONFLICT \(request_id\) DO NOTHING/i);
    assert.match(migration, /FOR UPDATE/i);
    assert.match(migration, /IF v_usage\.used >= v_usage\.allowance/i);
  });

  test("does not expose the quota SECURITY DEFINER function to public roles", () => {
    const migration = readFileSync(rpcSecurityMigrationPath, "utf8");
    const apiRoleMigration = readFileSync(apiRoleSecurityMigrationPath, "utf8");

    assert.match(
      migration,
      /REVOKE ALL ON FUNCTION public\.commerce_reserve_recognition_quota\(uuid, text, date\)\s+FROM PUBLIC/i,
    );
    assert.match(
      migration,
      /GRANT EXECUTE ON FUNCTION public\.commerce_reserve_recognition_quota\(uuid, text, date\)\s+TO service_role/i,
    );
    assert.match(
      apiRoleMigration,
      /REVOKE ALL ON FUNCTION public\.commerce_reserve_recognition_quota\(uuid, text, date\)\s+FROM PUBLIC, anon, authenticated/i,
    );
  });
});
