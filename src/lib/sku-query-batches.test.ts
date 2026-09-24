import assert from "node:assert/strict";
import { test } from "node:test";
import { readSkuBatches } from "./sku-query-batches";

test("448 SKU ids never produce a request exceeding 100 ids", async () => {
  const ids = Array.from({ length: 448 }, (_, i) => String(i));
  const sizes: number[] = [];
  const rows = await readSkuBatches(ids, async batch => {
    sizes.push(batch.length);
    return { data: batch, error: null };
  });
  assert.deepEqual(sizes, [100, 100, 100, 100, 48]);
  assert.deepEqual(rows, ids);
});
test("failed batches cannot masquerade as zero stock or empty products", async () => {
  await assert.rejects(readSkuBatches(["x"], async () => ({ data: null, error: { message: "fetch failed" } })), /fetch failed/);
  assert.deepEqual(await readSkuBatches([], async () => { throw new Error("must not query"); }), []);
});
