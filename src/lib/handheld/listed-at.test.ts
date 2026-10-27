// Run: node --experimental-strip-types --test src/lib/handheld/listed-at.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { compareListed, resolveListedAt, storePublishedAtMap } from "./listed-at.ts";

const A = "loc-a", B = "loc-b";
const rows = [
  { sku_id: "s1", location_id: A, published_at: "2026-10-20T00:00:00Z" },
  { sku_id: "s1", location_id: B, published_at: "2026-10-26T00:00:00Z" },
  { sku_id: "s2", location_id: B, published_at: "2026-10-25T00:00:00Z" },
  { sku_id: "s3", location_id: A, published_at: "garbage" },
];

test("本店与别店发布日期不同：只取本店", () => {
  const mapA = storePublishedAtMap(rows, A);
  const mapB = storePublishedAtMap(rows, B);
  assert.equal(resolveListedAt({ id: "s1", created_at: "2026-01-01T00:00:00Z" }, mapA).listed_at, "2026-10-20T00:00:00.000Z");
  assert.equal(resolveListedAt({ id: "s1", created_at: "2026-01-01T00:00:00Z" }, mapB).listed_at, "2026-10-26T00:00:00.000Z");
});

test("本店无发布记录不借用别店，回退 SKU 创建时间", () => {
  const r = resolveListedAt({ id: "s2", created_at: "2026-02-02T00:00:00Z" }, storePublishedAtMap(rows, A));
  assert.deepEqual(r, { listed_at: "2026-02-02T00:00:00.000Z", listed_at_source: "sku_created_at_fallback" });
});

test("发布日期损坏回退创建时间；两者都坏为 null/unavailable", () => {
  const map = storePublishedAtMap(rows, A);
  assert.equal(resolveListedAt({ id: "s3", created_at: "2026-03-03T00:00:00Z" }, map).listed_at_source, "sku_created_at_fallback");
  assert.deepEqual(resolveListedAt({ id: "s3", created_at: "bad" }, map), { listed_at: null, listed_at_source: "unavailable" });
});

test("未指定门店（全部范围）不取任何门店发布记录", () => {
  assert.equal(storePublishedAtMap(rows, null).size, 0);
});

test("排序：降序/升序，无效时间排最后", () => {
  const items = [{ listed_at: "2026-10-01T00:00:00Z" }, { listed_at: null }, { listed_at: "2026-10-05T00:00:00Z" }];
  assert.deepEqual([...items].sort((a, b) => compareListed(a, b, "desc")).map((i) => i.listed_at), ["2026-10-05T00:00:00Z", "2026-10-01T00:00:00Z", null]);
  assert.deepEqual([...items].sort((a, b) => compareListed(a, b, "asc")).map((i) => i.listed_at), ["2026-10-01T00:00:00Z", "2026-10-05T00:00:00Z", null]);
  assert.equal(compareListed({ listed_at: "2026-10-01T00:00:00Z" }, { listed_at: "2026-10-01T00:00:00.000Z" }, "desc"), 0);
});
