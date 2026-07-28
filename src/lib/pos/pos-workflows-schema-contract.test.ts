import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

const migrationUrl = new URL(
  "../../../supabase/migrations/20260728120000_pos_member_discount_workflows.sql",
  import.meta.url,
);

describe("POS member, discount, hold and return schema contract", () => {
  test("stores member benefits, discount authorization and held carts", () => {
    assert.equal(existsSync(migrationUrl), true);
    const sql = readFileSync(migrationUrl, "utf8");
    for (const table of [
      "pos_customer_wallets",
      "pos_customer_coupons",
      "pos_discount_policies",
      "pos_authorizations",
      "pos_held_carts",
      "pos_held_cart_items",
      "pos_returns",
      "pos_return_items",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE public\\.${table}`));
    }
  });

  test("persists immutable sale pricing snapshots and privileged mutations", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    assert.match(sql, /discount_snapshot jsonb/);
    assert.match(sql, /benefit_snapshot jsonb/);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.pos_complete_sale_v2/);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.pos_complete_return/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.pos_complete_sale_v2[\s\S]+FROM PUBLIC/);
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.pos_complete_sale_v2[\s\S]+TO service_role/,
    );
  });
});
