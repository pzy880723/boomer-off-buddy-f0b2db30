import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertStandardCatalogSyncHost,
  buildStandardYouzanRemoteIdentity,
  parseStandardCatalogSyncRequest,
  selectStandardCatalogTargetShops,
} from "./standard-catalog-youzan-sync";

test("standard catalog Youzan sync defaults to a bounded dry run", () => {
  assert.deepEqual(parseStandardCatalogSyncRequest({}), {
    dryRun: true,
    confirm: "",
    limit: 10,
    offset: 0,
    targetStock: 9999,
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

test("ERP EAN barcode is the remote SKU identity used by Youzan POS", () => {
  assert.deepEqual(
    buildStandardYouzanRemoteIdentity({
      skuId: "11111111-1111-1111-1111-111111111111",
      skuCode: "SKU-STD-JW",
      barcode: "2009876212904",
      name: "珠宝首饰",
      priceTier: 159,
    }),
    { code: "2009876212904", name: "珠宝首饰 159元" },
  );
});

test("standard catalog targets every active Youzan branch exactly once", () => {
  const targets = selectStandardCatalogTargetShops([
    { id: "hq", shop_name: "总部", kdt_id: 1, role: "hq", status: "active" },
    { id: "a", shop_name: "A店", kdt_id: 101, role: "branch", status: "active" },
    { id: "b", shop_name: "B店", kdt_id: "102", role: "branch", status: "active" },
    { id: "dup", shop_name: "重复授权", kdt_id: 102, role: "branch", status: "active" },
    { id: "off", shop_name: "停用店", kdt_id: 103, role: "branch", status: "disabled" },
  ]);
  assert.deepEqual(targets.map((shop) => shop.id), ["a", "b"]);
});

test("production batch sync is not hard-coded to one shop and includes barcodes", () => {
  const route = readFileSync(
    "src/routes/api/public/hooks/youzan-standard-catalog-sync.ts",
    "utf8",
  );
  assert.match(route, /selectStandardCatalogTargetShops/);
  assert.match(route, /sku_code, barcode, name/);
  assert.doesNotMatch(route, /da06cdae-5ec1-4749-8dcb-dc972cfd05c9/);
});

test("new and edited standard products use the all-branch mirror-stock path", () => {
  const inventory = readFileSync("src/lib/inventory.functions.ts", "utf8");
  assert.match(inventory, /syncStandardSkuToAllYouzanBranchesCore\(sid, 9999\)/);
  assert.match(inventory, /autoDistributeInBackground\(\[\.\.\.ids, \.\.\.addedIds\], \[\]\)/);
});

test("chain probing sends a valid page and persists kdt fallback only after branch verification", () => {
  const youzan = readFileSync("src/lib/youzan.functions.ts", "utf8");
  const sync = readFileSync("src/lib/youzan-sync.functions.ts", "utf8");
  assert.match(youzan, /params: \{ page_num: 1, page_size: 50 \}/);
  assert.match(sync, /via: "branch_kdt_fallback"/);
  assert.match(sync, /const confirmedChannelIds = Array\.from\(new Set\(targetChannelIds\)\)/);
  assert.match(sync, /chain_probe_status: "ok"/);
});

test("standard catalog uses the offline retail-store release path", () => {
  const server = readFileSync("src/lib/standard-catalog-youzan.server.ts", "utf8");
  assert.match(server, /releaseSkuToOfflineShopsCore/);
  assert.doesNotMatch(server, /releaseSkuToBranchCore/);
  assert.doesNotMatch(server, /pushYouzanQuantityUpdate/);
});

test("branch stock failures invalidate stale links and listings", () => {
  const server = readFileSync("src/lib/youzan-offline-products.functions.ts", "utf8");
  assert.match(server, /status: "error",\s*role: "branch_stock"/);
  assert.match(server, /listing_status: "error"/);
  assert.match(server, /channel: "youzan_branch_offline"/);
});
