import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

const root = new URL("../../routes/api/public/pos/", import.meta.url);

describe("POS API contract", () => {
  for (const file of [
    "bootstrap.ts",
    "products.ts",
    "products.lookup.ts",
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
