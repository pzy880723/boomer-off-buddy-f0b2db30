import assert from "node:assert/strict";
import { test } from "node:test";
import { filterImageReadyListings } from "./storefront-readiness.server";

test("DB readiness excludes legacy/raw/failed products before totals or signing", async () => {
  const rows = ["legacy", "raw_declined", "failed", "ready", "standard"].map((sku_id) => ({ sku_id }));
  assert.deepEqual(await filterImageReadyListings(rows, async () => ["ready", "standard"]), rows.slice(3));
});
test("readiness read failure fails closed instead of displaying products", async () => {
  await assert.rejects(filterImageReadyListings([{ sku_id: "failed" }], async () => { throw new Error("unavailable"); }));
});
test("eligibility never fabricates a missing receipt and preserves listing order", async () => {
  assert.deepEqual(await filterImageReadyListings([{ sku_id: "b" }, { sku_id: "a" }], async () => ["a", "b"]), [{ sku_id: "b" }, { sku_id: "a" }]);
  assert.deepEqual(await filterImageReadyListings([{ sku_id: "missing" }], async () => []), []);
});