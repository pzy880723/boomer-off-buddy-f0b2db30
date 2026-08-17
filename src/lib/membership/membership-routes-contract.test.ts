import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const route = (name: string) =>
  readFileSync(new URL(`../../routes/api/public/storefront/${name}.ts`, import.meta.url), "utf8");

describe("ERP storefront membership routes", () => {
  test("all customer routes authenticate through ERP consumer identity", () => {
    for (const name of [
      "membership.account",
      "membership.plans",
      "membership.orders",
      "membership.apple.transactions",
      "membership.recognition-quota.reserve",
      "membership.coupons",
      "membership.points-ledger",
      "membership.consumption-records",
      "membership.member-code",
    ]) {
      assert.match(route(name), /authenticateStorefrontCustomer\(request\)/);
    }
  });

  test("recognition reservation requires an idempotent request id", () => {
    const source = route("membership.recognition-quota.reserve");
    assert.match(source, /request_id/);
    assert.match(source, /reserveRecognitionQuota\(auth\.customer\.id, requestId\)/);
    assert.doesNotMatch(source, /customer_id/);
  });
});
