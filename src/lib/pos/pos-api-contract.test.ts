import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

const root = new URL("../../routes/api/public/pos/", import.meta.url);

describe("POS API contract", () => {
  for (const file of [
    "bootstrap.ts",
    "resolve-code.ts",
    "products.ts",
    "products.lookup.ts",
    "customers.search.ts",
    "customers.$id.benefits.ts",
    "discounts.preview.ts",
    "authorizations.ts",
    "carts.hold.ts",
    "carts.held.ts",
    "carts.$id.resume.ts",
    "carts.$id.ts",
    "orders.search.ts",
    "orders.$id.returns.preview.ts",
    "orders.$id.returns.ts",
    "shifts.open.ts",
    "sales.ts",
    "sales.$id.receipt.ts",
    "shifts.$id.close.ts",
  ]) {
    test(`provides ${file}`, () => {
      const url = new URL(file, root);
      assert.equal(existsSync(url), true);
      assert.match(readFileSync(url, "utf8"), /authenticatePosUser/);
    });
  }
});
