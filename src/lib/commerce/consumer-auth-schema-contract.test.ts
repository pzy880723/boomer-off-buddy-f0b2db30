import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const migration = readFileSync(
  new URL("../../../supabase/migrations/20260726153000_consumer_identity.sql", import.meta.url),
  "utf8",
);
const ordersRoute = readFileSync(
  new URL("../../routes/api/public/storefront/orders.ts", import.meta.url),
  "utf8",
);
const paymentsRoute = readFileSync(
  new URL("../../routes/api/public/storefront/payments.ts", import.meta.url),
  "utf8",
);

describe("consumer identity is independent from ERP employee auth", () => {
  test("stores Tencent subjects and linked login providers", () => {
    assert.match(migration, /CREATE TABLE public\.commerce_customers/i);
    assert.match(migration, /external_subject text NOT NULL UNIQUE/i);
    assert.match(migration, /CREATE TABLE public\.commerce_customer_identities/i);
    assert.match(migration, /provider IN \('phone','wechat'\)/i);
  });

  test("storefront order and payment ownership uses customer_id", () => {
    assert.match(ordersRoute, /\.eq\("customer_id", auth\.customer\.id\)/);
    assert.match(paymentsRoute, /\.eq\("customer_id", auth\.customer\.id\)/);
    assert.doesNotMatch(ordersRoute, /\.eq\("user_id", auth\.user\.id\)/);
    assert.doesNotMatch(paymentsRoute, /\.eq\("user_id", auth\.user\.id\)/);
  });
});
