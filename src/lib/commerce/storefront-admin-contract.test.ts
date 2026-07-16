import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const route = readFileSync(
  new URL("../../routes/shop-mgmt.online.tsx", import.meta.url),
  "utf8",
);

describe("self-operated storefront product administration", () => {
  test("uses real commerce listings instead of a planning placeholder", () => {
    assert.doesNotMatch(route, /网店模块规划中/);
    assert.match(route, /listStorefrontListings/);
  });

  test("offers the four requested product lifecycle tabs", () => {
    for (const label of ["已上架", "已下架", "已售罄", "回收站"]) {
      assert.match(route, new RegExp(label));
    }
  });

  test("shows shared category, brand, store, and stock fields", () => {
    for (const field of ["商品分类", "品牌", "所属门店", "门店库存"]) {
      assert.match(route, new RegExp(field));
    }
  });
});
