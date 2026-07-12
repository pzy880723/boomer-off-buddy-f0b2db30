import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260713090000_commerce_fulfillment_core.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("commerce fulfillment schema contract", () => {
  test("commerce mutations are restricted to the service role", () => {
    assert.match(
      migration,
      /REVOKE ALL ON FUNCTION public\.commerce_create_order[\s\S]+FROM PUBLIC/,
    );
    assert.match(
      migration,
      /GRANT EXECUTE ON FUNCTION public\.commerce_create_order[\s\S]+TO service_role/,
    );
    assert.doesNotMatch(migration, /GRANT EXECUTE[\s\S]+TO (?:anon|authenticated)/);
  });

  test("checkout and payment enforce reservation integrity", () => {
    assert.match(migration, /interval '15 minutes'/);
    assert.match(migration, /order contains duplicate listings/);
    assert.match(migration, /order reservation expired/);
    assert.match(migration, /order inventory reservation is incomplete/);
    assert.match(migration, /provider_transaction_id text UNIQUE/);
  });

  test("handheld scans are idempotent and location scoped", () => {
    assert.match(migration, /uniq_fulfillment_scan_client_op/);
    assert.match(migration, /location_id = p_location_id FOR UPDATE/);
    assert.match(migration, /fulfillment_complete_pick/);
  });

  test("commerce movement types preserve existing ERP stock audit values", () => {
    for (const refType of ["shop_adjust", "shop_new_sku", "return_inspection"]) {
      assert.match(migration, new RegExp(`'${refType}'`));
    }
    assert.match(migration, /ref_type LIKE 'sale:%'/);
  });
});
