import assert from "node:assert/strict";
import test from "node:test";

import {
  assertStandardCatalogSyncHost,
  buildStandardYouzanRemoteIdentity,
  CITIC_TAIFU_YOUZAN_SHOP_ID,
  parseStandardCatalogSyncRequest,
} from "./standard-catalog-youzan-sync";

test("standard catalog Youzan sync defaults to a bounded dry run", () => {
  assert.deepEqual(parseStandardCatalogSyncRequest({}), {
    dryRun: true,
    confirm: "",
    limit: 10,
    offset: 0,
    targetStock: 9999,
    shopId: CITIC_TAIFU_YOUZAN_SHOP_ID,
  });
});

test("standard catalog Youzan sync caps each batch at 20 products", () => {
  assert.equal(parseStandardCatalogSyncRequest({ limit: 200 }).limit, 20);
  assert.equal(parseStandardCatalogSyncRequest({ limit: 0 }).limit, 1);
});

test("standard catalog Youzan mutation requires an explicit confirmation phrase", () => {
  assert.throws(() => parseStandardCatalogSyncRequest({ dry_run: false }), /SYNC_STANDARD_CATALOG/);
  assert.equal(
    parseStandardCatalogSyncRequest({
      dry_run: false,
      confirm: "SYNC_STANDARD_CATALOG",
    }).dryRun,
    false,
  );
});

test("Youzan mirror stock is finite and bounded even though ERP stock is unlimited", () => {
  assert.equal(parseStandardCatalogSyncRequest({ target_stock: -1 }).targetStock, 1);
  assert.equal(parseStandardCatalogSyncRequest({ target_stock: 1_000_000 }).targetStock, 9999);
});

test("mutations are rejected outside the Tencent fixed-egress hostname", () => {
  assert.doesNotThrow(() => assertStandardCatalogSyncHost("lovable.app", true));
  assert.throws(() => assertStandardCatalogSyncHost("lovable.app", false), /erp\.boomeroff\.com/);
  assert.doesNotThrow(() => assertStandardCatalogSyncHost("erp.boomeroff.com", false));
});

test("each standard price tier gets a stable unique Youzan identity", () => {
  const low = buildStandardYouzanRemoteIdentity({
    skuId: "11111111-1111-1111-1111-111111111111",
    skuCode: "SKU-STD-JW",
    name: "珠宝首饰",
    priceTier: 6.9,
  });
  const high = buildStandardYouzanRemoteIdentity({
    skuId: "22222222-2222-2222-2222-222222222222",
    skuCode: "SKU-STD-JW",
    name: "珠宝首饰",
    priceTier: 1580,
  });

  assert.notEqual(low.code, high.code);
  assert.equal(low.name, "珠宝首饰 6.9元");
  assert.equal(high.name, "珠宝首饰 1580元");
  assert.ok(low.code.length <= 64);
});
