import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";

const migrationsUrl = new URL("../../../supabase/migrations/", import.meta.url);
const migrationName = readdirSync(migrationsUrl).find((name) =>
  name.endsWith("_unify_commerce_and_pos.sql"),
);

describe("unified commerce and POS schema contract", () => {
  test("adds quantity-aware reservation and order contracts", () => {
    assert.ok(migrationName, "unify_commerce_and_pos migration is required");
    const sql = readFileSync(new URL(migrationName!, migrationsUrl), "utf8");
    assert.match(sql, /ALTER TABLE public\.commerce_order_items[\s\S]+quantity/);
    assert.match(sql, /CREATE TABLE public\.inventory_reservation_lines/);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.commerce_create_order_v2/);
    assert.match(sql, /p_items jsonb/);
  });

  test("adds payment facts and POS operations", () => {
    assert.ok(migrationName, "unify_commerce_and_pos migration is required");
    const sql = readFileSync(new URL(migrationName!, migrationsUrl), "utf8");
    for (const table of [
      "commerce_payments",
      "commerce_payment_events",
      "commerce_refunds",
      "pos_registers",
      "pos_shifts",
      "pos_cash_movements",
      "pos_receipts",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE public\\.${table}`));
    }
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.pos_complete_sale/);
  });

  test("keeps privileged mutations backend-only", () => {
    assert.ok(migrationName, "unify_commerce_and_pos migration is required");
    const sql = readFileSync(new URL(migrationName!, migrationsUrl), "utf8");
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.commerce_create_order_v2[\s\S]+FROM PUBLIC/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.pos_complete_sale[\s\S]+FROM PUBLIC/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.pos_complete_sale[\s\S]+TO service_role/);
    assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION public\.pos_complete_sale[\s\S]+TO anon/);
  });
});
