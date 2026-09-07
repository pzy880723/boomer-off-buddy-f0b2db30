import test from "node:test";
import assert from "node:assert/strict";
import { ProductLookupQuery, ProductsQuery, ProductsRes, SkuDetailRes, SmartCreateReq } from "./schemas";

test("explicit all-store scope is in the handheld contract", () => {
  assert.equal(ProductsQuery.safeParse({ scope: "all" }).success, true);
});

test("scoped product response requires a scope identity even when empty", () => {
  const data = { items: [], total: 0, page: 1, page_size: 50, counts: { custom: 0, bundle: 0, standard: 0, all: 0 } };
  assert.equal(ProductsRes.safeParse({ ok: true, data }).success, false);
  assert.equal(ProductsRes.safeParse({ ok: true, data: { ...data, scope: "all" } }).success, true);
});

test("lookup and detail document the same explicit scope contract", () => {
  assert.equal(ProductLookupQuery.parse({ scope: "all", code: "test" }).scope, "all");
  const fields = SkuDetailRes.shape.data.shape;
  for (const key of ["scope", "product_type", "is_unlimited_stock", "editable", "brand", "era", "ip_name", "attributes"]) {
    assert.ok(key in fields, `Missing detail field: ${key}`);
  }
  assert.equal(fields.scope.safeParse(undefined).success, false);
});

test("brand contract distinguishes omitted from explicitly cleared", () => {
  const body = { name: "Hello Kitty", category: "toy_character_figure", price_tier: 45 };
  assert.equal(SmartCreateReq.parse(body).brand, undefined);
  assert.equal(SmartCreateReq.parse({ ...body, brand: null }).brand, null);
  assert.equal(SmartCreateReq.parse({ ...body, brand: " 三丽鸥 " }).brand, "三丽鸥");
});
