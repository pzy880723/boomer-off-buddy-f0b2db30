import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

const routesRoot = new URL("../../routes/api/public/storefront/", import.meta.url);

describe("storefront payment contract", () => {
  test("provides authenticated payment creation and signed callbacks", () => {
    for (const file of ["payments.ts", "payments.callback.$provider.ts"]) {
      const url = new URL(file, routesRoot);
      assert.equal(existsSync(url), true, `${file} is required`);
    }
    const createSource = readFileSync(new URL("payments.ts", routesRoot), "utf8");
    const callbackSource = readFileSync(
      new URL("payments.callback.$provider.ts", routesRoot),
      "utf8",
    );
    const helperSource = readFileSync(
      new URL("../../server/storefront-payment.server.ts", import.meta.url),
      "utf8",
    );
    assert.match(createSource, /authenticateStorefrontCustomer/);
    assert.match(createSource, /idempotency-key/i);
    assert.match(createSource, /payment_payload/);
    assert.match(createSource, /replayed: true/);
    assert.match(createSource, /buildStorePaymentPlan/);
    assert.match(createSource, /commerce_payment_suborders/);
    assert.match(createSource, /store_payment_not_ready/);
    assert.match(createSource, /sub_orders/);
    assert.match(helperSource, /STOREFRONT_PAYMENT_GATEWAY_URL/);
    assert.match(helperSource, /STOREFRONT_PAYMENT_WEBHOOK_SECRET/);
    assert.match(callbackSource, /commerce_mark_order_paid/);
    assert.match(callbackSource, /signature_verified/);
  });
});
