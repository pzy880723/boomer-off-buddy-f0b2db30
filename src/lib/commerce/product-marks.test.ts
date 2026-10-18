import { test } from "node:test";
import assert from "node:assert/strict";
import { FeaturedStampSchema, NoticeTagsSchema, readProductMarks, FEATURED_STAMP_LABELS, NOTICE_TAG_LABELS } from "./product-marks.ts";
import { ItemPatchReq } from "../handheld/item-edit-schemas.ts";
import { buildStorefrontProduct } from "../../server/storefront-products.server.ts";

test("featured stamp: whitelist only, null clears", () => {
  for (const v of ["new", "rare", "limited", "collectible", "discontinued", null]) assert.ok(FeaturedStampSchema.safeParse(v).success);
  assert.equal(FeaturedStampSchema.safeParse("vintage").success, false);
  assert.equal(FeaturedStampSchema.safeParse("全新品").success, false);
  assert.equal(FEATURED_STAMP_LABELS.discontinued, "绝版商品");
});
test("notice tags: multi-select whitelist, uncertain/unavailable mutually exclusive, no duplicates", () => {
  assert.ok(NoticeTagsSchema.safeParse([]).success);
  assert.ok(NoticeTagsSchema.safeParse(["flawed", "function_uncertain", "not_edible"]).success);
  assert.equal(NoticeTagsSchema.safeParse(["function_uncertain", "function_unavailable"]).success, false);
  assert.equal(NoticeTagsSchema.safeParse(["flawed", "flawed"]).success, false);
  assert.equal(NoticeTagsSchema.safeParse(["broken"]).success, false);
  assert.equal(NOTICE_TAG_LABELS.not_edible, "不可食用");
});
test("handheld patch accepts marks alone and rejects invalid/exclusive", () => {
  const base = { location_id: "00000000-0000-0000-0000-000000000001", client_op_id: "op-12345678", expected_updated_at: "2026-10-18T00:00:00Z" };
  assert.ok(ItemPatchReq.safeParse({ ...base, featured_stamp: "rare" }).success);
  assert.ok(ItemPatchReq.safeParse({ ...base, featured_stamp: null }).success);
  assert.ok(ItemPatchReq.safeParse({ ...base, notice_tags: ["flawed"] }).success);
  assert.equal(ItemPatchReq.safeParse({ ...base, notice_tags: ["function_uncertain", "function_unavailable"] }).success, false);
  assert.equal(ItemPatchReq.safeParse({ ...base, featured_stamp: "x" }).success, false);
});
test("DTO reader drops unknown values and keeps dictionary order", () => {
  assert.deepEqual(readProductMarks({ featured_stamp: "bogus", notice_tags: ["not_edible", "x", "flawed"] }),
    { featured_stamp: null, notice_tags: ["flawed", "not_edible"] });
  assert.deepEqual(readProductMarks({}), { featured_stamp: null, notice_tags: [] });
});
test("storefront product DTO carries featured_stamp and notice_tags at top level from SKU", () => {
  const p = buildStorefrontProduct({
    listing: { id: "l1", sku_id: "s1", title: "t", description: null, price: 10, compare_at_price: null, cover_url: null,
      image_urls: [], product_type: "single", condition_grade: null, location: null, published_at: null } as never,
    sku: { id: "s1", category: null, keywords: [], stock_qty: 1, featured_stamp: "limited", notice_tags: ["flawed"] } as never,
    category: null, brand: null, facets: [], availableQty: 1,
  }) as Record<string, unknown>;
  assert.equal(p.featured_stamp, "limited");
  assert.deepEqual(p.notice_tags, ["flawed"]);
  const q = buildStorefrontProduct({
    listing: { id: "l1", sku_id: "s1", title: "t", price: 10 } as never,
    sku: { id: "s1", category: null, keywords: [], stock_qty: 0 } as never,
    category: null, brand: null, facets: [], availableQty: 0,
  }) as Record<string, unknown>;
  assert.equal(q.featured_stamp, null); assert.deepEqual(q.notice_tags, []);
});
