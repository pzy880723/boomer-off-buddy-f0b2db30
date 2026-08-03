import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  GLOBAL_STANDARD_SKU_FILTER,
  inheritsGlobalStandardCatalog,
  resolveShopVisibleSkuIds,
} from "./shop-standard-catalog";

const STANDARD_SKUS = Array.from({ length: 372 }, (_, i) => `standard-${i}`);

test("a brand-new Vintage shop with no stock/link/movement still sees every standard SKU", () => {
  const visible = resolveShopVisibleSkuIds({
    storeFormat: "vintage",
    stockSkuIds: [],
    linkSkuIds: [],
    movementSkuIds: [],
    globalStandardSkuIds: STANDARD_SKUS,
  });
  assert.equal(visible.length, 372);
  assert.deepEqual(visible.slice().sort(), STANDARD_SKUS.slice().sort());
});

test("a non-Vintage shop does not inherit the global standard catalog", () => {
  assert.equal(inheritsGlobalStandardCatalog("vintage"), true);
  assert.equal(inheritsGlobalStandardCatalog("outlet"), false);
  assert.equal(inheritsGlobalStandardCatalog(null), false);

  const visible = resolveShopVisibleSkuIds({
    storeFormat: "outlet",
    stockSkuIds: ["shop-custom-1"],
    linkSkuIds: [],
    movementSkuIds: ["shop-custom-1"],
    globalStandardSkuIds: STANDARD_SKUS,
  });
  assert.deepEqual(visible, ["shop-custom-1"]);
});

test("shop-specific custom/bundle SKUs stay isolated per shop", () => {
  const visible = resolveShopVisibleSkuIds({
    storeFormat: "vintage",
    stockSkuIds: ["custom-a"],
    linkSkuIds: ["bundle-b"],
    movementSkuIds: ["custom-a"],
    globalStandardSkuIds: ["standard-1"],
  });
  assert.deepEqual(visible.slice().sort(), ["bundle-b", "custom-a", "standard-1"]);
});

test("the global standard filter never copies SKUs or stock rows per shop", () => {
  assert.deepEqual(GLOBAL_STANDARD_SKU_FILTER, {
    kind: "single",
    is_custom_price: false,
    inventory_policy: "unlimited",
    is_display: true,
    status: "active",
  });

  const fn = readFileSync("src/lib/shop-products.functions.ts", "utf8");
  assert.match(fn, /resolveShopVisibleSkuIds/);
  // 不允许为门店批量复制标准 SKU 或批量写库存
  assert.doesNotMatch(fn, /insert\(\s*standard/i);
});

test("new shops default to store_format=vintage and get an auto shop location trigger", () => {
  const shops = readFileSync("src/lib/shops.functions.ts", "utf8");
  assert.match(shops, /store_format:\s*"vintage"/);

  const migration = readdirSync("supabase/migrations").find((name) =>
    readFileSync(`supabase/migrations/${name}`, "utf8").includes(
      "trg_youzan_shop_ensure_location",
    ),
  );
  assert.ok(migration, "shop location trigger migration must exist");
});


test("the shop products page has no manual sync / create-standard-product entry points", () => {
  const page = readFileSync("src/routes/shop-mgmt.products.tsx", "utf8");

  assert.doesNotMatch(page, /该门店还没有标准商品/);
  assert.doesNotMatch(page, /会自动同步到本店/);
  assert.doesNotMatch(page, /标准商品（多价格档）/);
  assert.doesNotMatch(page, /StandardSkuDialog/);
  assert.doesNotMatch(page, /批量维护标准商品去仓库/);

  assert.match(page, /标准商品由总部统一维护，所有 Vintage 门店自动可售，无需入库或同步。/);
  assert.match(page, /标准商品加载异常/);
  assert.match(page, /重新加载/);
});
