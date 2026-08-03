import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const route = readFileSync(
  new URL("../routes/api/public/handheld/items.$id.restock.ts", import.meta.url),
  "utf8",
);

describe("handheld sold-out restock", () => {
  test("reactivates a custom SKU and its marketplace listing", () => {
    assert.match(route, /is_custom_price/);
    assert.match(route, /sales_state:\s*"active"/);
    assert.match(route, /from\("commerce_listings"\)/);
    assert.match(route, /status:\s*isDisplay \? "published" : "hidden"/);
    assert.match(route, /sold_at:\s*null/);
  });
});
