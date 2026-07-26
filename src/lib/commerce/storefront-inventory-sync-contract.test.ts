import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(
  new URL("../../../supabase/migrations/", import.meta.url),
);
const migrations = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(join(migrationsDir, name), "utf8"))
  .join("\n");

function latestFunctionBody(name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}`;
  const start = migrations.lastIndexOf(marker);
  assert.notEqual(start, -1, `${name} must be defined`);
  const bodyStart = migrations.indexOf("AS $$", start);
  const bodyEnd = migrations.indexOf("$$;", bodyStart);
  assert.notEqual(bodyStart, -1, `${name} must have a function body`);
  assert.notEqual(bodyEnd, -1, `${name} must close its function body`);
  return migrations.slice(start, bodyEnd + 3);
}

describe("self-operated storefront inventory synchronization", () => {
  test("a physical store sale marks the self-operated listing sold", () => {
    const body = latestFunctionBody("sync_commerce_listing_on_store_sale");
    assert.match(body, /UPDATE public\.commerce_listings/);
    assert.match(body, /status = 'sold'/);
    assert.match(body, /UPDATE public\.inventory_reservations/);
  });

  test("checkout reservation freezes branch sale channels", () => {
    const body = latestFunctionBody("sync_branch_channels_on_commerce_reservation");
    assert.match(body, /commerce_reserve/);
    assert.match(body, /'set_stock_zero'/);
  });

  test("expired checkout reservation restores branch sale channels", () => {
    const body = latestFunctionBody("sync_branch_channels_on_commerce_reservation");
    assert.match(body, /commerce_reservation_release/);
    assert.match(body, /'restore_after_return'/);
  });
});
