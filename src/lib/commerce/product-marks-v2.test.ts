import { test } from "node:test";
import assert from "node:assert/strict";
import { NoticeTagsSchema, NOTICE_TAG_LABELS, readProductMarks, productMarkLabels } from "./product-marks.ts";
import { planMarkChange } from "./product-marks-batch.ts";
import { resolveCategoryLabel } from "./category-labels.ts";
import { buildStorefrontProduct } from "../../server/storefront-products.server.ts";

test("parts_missing 零件缺失 is an allowed, combinable notice tag", () => {
  assert.equal(NOTICE_TAG_LABELS.parts_missing, "零件缺失");
  assert.ok(NoticeTagsSchema.safeParse(["flawed", "function_unavailable", "parts_missing"]).success);
  assert.equal(NoticeTagsSchema.safeParse(["function_uncertain", "function_unavailable", "parts_missing"]).success, false);
  assert.deepEqual(readProductMarks({ notice_tags: ["parts_missing", "flawed"] }).notice_tags, ["flawed", "parts_missing"]);
});

test("labels: stamp first then every notice tag in dictionary order", () => {
  assert.deepEqual(productMarkLabels({ featured_stamp: "rare", notice_tags: ["parts_missing", "flawed", "x"] }),
    [{ kind: "stamp", key: "rare", label: "稀有商品" }, { kind: "notice", key: "flawed", label: "有瑕疵" },
     { kind: "notice", key: "parts_missing", label: "零件缺失" }]);
  assert.deepEqual(productMarkLabels({ featured_stamp: null, notice_tags: [] }), []);
});

const sku = { status: "active", is_custom_price: true, kind: "single", inventory_policy: "tracked", stock_qty: 1,
  featured_stamp: null, notice_tags: [] as string[], fankuang_override: null, price_tier: 39 };

test("batch notice: append by default, explicit remove, idempotent", () => {
  const a = planMarkChange({ ...sku, notice_tags: ["not_edible"] }, { kind: "notice", add: ["parts_missing"], remove: [] });
  assert.deepEqual(a, { outcome: "apply", patch: { notice_tags: ["not_edible", "parts_missing"] } });
  const again = planMarkChange({ ...sku, notice_tags: ["not_edible", "parts_missing"] }, { kind: "notice", add: ["parts_missing"], remove: [] });
  assert.equal(again.outcome, "unchanged");
  const rm = planMarkChange({ ...sku, notice_tags: ["flawed", "parts_missing"] }, { kind: "notice", add: [], remove: ["parts_missing"] });
  assert.deepEqual(rm, { outcome: "apply", patch: { notice_tags: ["flawed"] } });
});

test("batch notice: flawed add requires per-item annotation, conflict skipped", () => {
  assert.equal(planMarkChange(sku, { kind: "notice", add: ["flawed"], remove: [] }).reason, "flawed_requires_annotation");
  const c = planMarkChange({ ...sku, notice_tags: ["function_unavailable"] }, { kind: "notice", add: ["function_uncertain"], remove: [] });
  assert.deepEqual([c.outcome, c.reason], ["skipped", "function_conflict"]);
  const explicit = planMarkChange({ ...sku, notice_tags: ["function_unavailable"] },
    { kind: "notice", add: ["function_uncertain"], remove: ["function_unavailable"] });
  assert.deepEqual(explicit, { outcome: "apply", patch: { notice_tags: ["function_uncertain"] } });
});

test("batch stamp replaces single value; fankuang only for eligible in-stock items", () => {
  assert.deepEqual(planMarkChange({ ...sku, featured_stamp: "new" }, { kind: "stamp", value: "rare" }),
    { outcome: "apply", patch: { featured_stamp: "rare" } });
  assert.equal(planMarkChange({ ...sku, featured_stamp: "rare" }, { kind: "stamp", value: "rare" }).outcome, "unchanged");
  assert.deepEqual(planMarkChange(sku, { kind: "fankuang", value: true }), { outcome: "apply", patch: { fankuang_override: true } });
  assert.equal(planMarkChange({ ...sku, is_custom_price: false }, { kind: "fankuang", value: true }).reason, "fankuang_not_applicable");
  assert.equal(planMarkChange({ ...sku, stock_qty: 0 }, { kind: "fankuang", value: true }).reason, "sold_out");
  assert.equal(planMarkChange({ ...sku, status: "archived" }, { kind: "stamp", value: "rare" }).reason, "archived");
});

test("category label: real dictionary path, never raw code as name", () => {
  const rows = [{ id: "p", code: "ceramics", name: "陶瓷", parent_id: null }, { id: "c", code: "ceramics_cup", name: "杯", parent_id: "p" }];
  assert.deepEqual(resolveCategoryLabel("ceramics_cup", rows), { name: "杯", path: ["陶瓷", "杯"] });
  assert.deepEqual(resolveCategoryLabel("fashion_jewelry", []), { name: "珠宝首饰", path: ["珠宝首饰"] });
  assert.deepEqual(resolveCategoryLabel("zz_unknown", []), { name: null, path: [] });
  assert.deepEqual(resolveCategoryLabel(null, rows), { name: null, path: [] });
});

test("storefront unknown category outputs null name, no placeholder", () => {
  const q = buildStorefrontProduct({
    listing: { id: "l1", sku_id: "s1", title: "t", price: 10 } as never,
    sku: { id: "s1", category: "zz_unknown", keywords: [], stock_qty: 0 } as never,
    category: null, brand: null, facets: [], availableQty: 0,
  }) as { primary_category: { code: string; name: string | null; path: string[] } };
  assert.deepEqual(q.primary_category, { code: "zz_unknown", name: null, path: [] });
});
