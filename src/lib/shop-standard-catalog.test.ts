import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  GLOBAL_STANDARD_SKU_FILTER,
  inheritsGlobalStandardCatalog,
  resolveShopVisibleSkuIds,
} from "./shop-standard-catalog";

const STANDARD_SKUS = Array.from({ length: 372 }, (_, i) => `standard-${i}`);

test("a new Vintage shop inherits every standard SKU without shop rows", () => {
  const visible = resolveShopVisibleSkuIds({
    storeFormat: "vintage",
    stockSkuIds: [],
    linkSkuIds: [],
    movementSkuIds: [],
    globalStandardSkuIds: STANDARD_SKUS,
  });
  assert.equal(visible.length, 372);
});

test("a non-Vintage shop does not inherit the standard catalog", () => {
  assert.equal(inheritsGlobalStandardCatalog("vintage"), true);
  assert.equal(inheritsGlobalStandardCatalog("outlet"), false);
  assert.deepEqual(
    resolveShopVisibleSkuIds({
      storeFormat: "outlet",
      stockSkuIds: ["custom-1"],
      linkSkuIds: [],
      movementSkuIds: [],
      globalStandardSkuIds: STANDARD_SKUS,
    }),
    ["custom-1"],
  );
});

test("the global standard filter is active, visible and unlimited", () => {
  assert.deepEqual(GLOBAL_STANDARD_SKU_FILTER, {
    kind: "single",
    is_custom_price: false,
    inventory_policy: "unlimited",
    is_display: true,
    status: "active",
  });
});

test("new shops default to Vintage and automatically get a location", () => {
  const shops = readFileSync("src/lib/shops.functions.ts", "utf8");
  assert.match(shops, /store_format:\s*"vintage"/);
  const migration = readdirSync("supabase/migrations").find((name) =>
    readFileSync(`supabase/migrations/${name}`, "utf8").includes("trg_youzan_shop_ensure_location"),
  );
  assert.ok(migration);
});

test("the shop page has no manual standard-product sync or creation flow", () => {
  const page = readFileSync("src/routes/shop-mgmt.products.tsx", "utf8");
  assert.doesNotMatch(page, /该门店还没有标准商品/);
  assert.doesNotMatch(page, /会自动同步到本店/);
  assert.doesNotMatch(page, /标准商品（多价格档）/);
  assert.doesNotMatch(page, /StandardSkuDialog/);
  assert.match(page, /所有 Vintage 门店自动可售，无需入库或同步/);
  assert.match(page, /标准商品加载异常/);
  assert.match(page, /重新加载/);
});
