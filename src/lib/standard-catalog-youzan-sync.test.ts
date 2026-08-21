import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertStandardCatalogSyncHost,
  buildStandardChannelPublishParams,
  buildStandardItemImageUpdateParams,
  buildStandardStockWorkerLimit,
  buildStandardGroupOfflineReleaseParams,
  buildStandardGroupSpuCreateParams,
  buildHqSpuLookupParams,
  buildStandardYouzanRemoteIdentity,
  groupStandardCatalogSkus,
  isRecoverableStandardChannelPublishError,
  selectExactStandardBranchGroup,
  selectHqSpuRemoteIdentity,
  parseStandardCatalogSyncRequest,
  selectValidYouzanRetailCategory,
  selectStandardCatalogTargetShops,
} from "./standard-catalog-youzan-sync";

const groupedToySkus = [
  {
    id: "33333333-3333-3333-3333-333333333333",
    sku_code: "SKU-STD-TOY",
    barcode: "2000000000198",
    name: "玩具模型",
    category: "toy_model",
    price_tier: 19.9,
  },
  {
    id: "11111111-1111-1111-1111-111111111111",
    sku_code: "SKU-STD-TOY",
    barcode: "2000000000069",
    name: "玩具模型",
    category: "toy_model",
    price_tier: 6.9,
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    sku_code: "SKU-STD-TOY",
    barcode: "2000000000099",
    name: "玩具模型",
    category: "toy_model",
    price_tier: 9.9,
  },
];

test("standard price tiers group into one Youzan product", () => {
  const groups = groupStandardCatalogSkus([
    ...groupedToySkus,
    {
      ...groupedToySkus[0],
      id: "44444444-4444-4444-4444-444444444444",
      sku_code: "SKU-STD-HOME",
      barcode: "2000000001066",
      name: "家居杂货",
      category: "home_goods",
    },
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].name, "玩具模型");
  assert.deepEqual(groups[0].skus.map((sku) => sku.price_tier), [6.9, 9.9, 19.9]);
});

test("Youzan HQ payload keeps the product name and represents prices as SKU specs", () => {
  const group = groupStandardCatalogSkus(groupedToySkus)[0];
  const payload = buildStandardGroupSpuCreateParams({
    group,
    categoryId: 123,
    kdtIds: [456],
    imageUrl: "https://img.yzcdn.cn/toy.png",
  });

  assert.equal(payload.name, "玩具模型");
  assert.equal(payload.spu_code, "SKU-STD-TOY");
  assert.equal(payload.retail_price, "6.90");
  assert.equal(payload.skus.length, 3);
  assert.deepEqual(payload.skus.map((sku) => sku.specs), [
    [{ name: "价格", value: "6.9元" }],
    [{ name: "价格", value: "9.9元" }],
    [{ name: "价格", value: "19.9元" }],
  ]);
  assert.deepEqual(payload.skus.map((sku) => sku.sku_no), [
    "2000000000069",
    "2000000000099",
    "2000000000198",
  ]);
  assert.deepEqual(payload.skus.map((sku) => sku.sku_code), [
    "SKU-STD-TOY-P0000690",
    "SKU-STD-TOY-P0000990",
    "SKU-STD-TOY-P0001990",
  ]);
  assert.doesNotMatch(payload.name, /元|6\.9/);
  assert.equal(JSON.parse(payload.spec_define_tuple).length, 1);
});

test("Youzan branch payload releases one item with every price SKU", () => {
  const group = groupStandardCatalogSkus(groupedToySkus)[0];
  const payload = buildStandardGroupOfflineReleaseParams({
    group,
    categoryId: 123,
    branchKdtIds: [456],
    imageUrls: ["https://img.yzcdn.cn/toy.png"],
    hqSpuCode: "SKU-STD-TOY",
    stock: 9999,
  });

  assert.equal(payload.title, "玩具模型");
  assert.equal(payload.sku_center_code, "SKU-STD-TOY-P0000690");
  assert.equal(payload.stocks.length, 3);
  assert.deepEqual(payload.stocks.map((stock) => stock.sku_no), [
    "2000000000069",
    "2000000000099",
    "2000000000198",
  ]);
  assert.deepEqual(payload.stocks.map((stock) => stock.related_sku_code), [
    "SKU-STD-TOY-P0000690",
    "SKU-STD-TOY-P0000990",
    "SKU-STD-TOY-P0001990",
  ]);
});

test("standard prices are sorted numerically before every Youzan payload is built", () => {
  const group = groupStandardCatalogSkus([
    { ...groupedToySkus[0], price_tier: 109 },
    { ...groupedToySkus[1], price_tier: 19.9 },
    { ...groupedToySkus[2], price_tier: 9.9 },
  ])[0];

  assert.deepEqual(group.skus.map((sku) => sku.price_tier), [9.9, 19.9, 109]);
  assert.deepEqual(
    buildStandardGroupSpuCreateParams({
      group,
      categoryId: 123,
      kdtIds: [456],
    }).skus.map((sku) => sku.retail_price),
    ["9.90", "19.90", "109.00"],
  );
});

test("grouped standard products publish the existing HQ item to store channel", () => {
  assert.deepEqual(buildStandardChannelPublishParams(6235775735), {
    item_id: 6235775735,
    channel: 1,
    operate_type: 1,
    display: 1,
  });
});

test("standard product images update through the common item media contract", () => {
  assert.deepEqual(buildStandardItemImageUpdateParams(6235775735, [1580494287, 1580494287]), {
    item_id: 6235775735,
    media: { image_ids: [1580494287] },
  });
});

test("standard stock worker consumes every SKU and branch task", () => {
  assert.equal(buildStandardStockWorkerLimit(31, 2), 62);
  assert.equal(buildStandardStockWorkerLimit(31, 10), 200);
});

test("channel publishing waits for Youzan asynchronous completion errors", () => {
  assert.equal(
    isRecoverableStandardChannelPublishError(new Error("[122001001] 商品不存在!")),
    true,
  );
  assert.equal(
    isRecoverableStandardChannelPublishError(
      new Error("[301002564] 商品已发布到指定渠道，无需再次发布"),
    ),
    true,
  );
  assert.equal(isRecoverableStandardChannelPublishError(new Error("参数错误")), false);
});

test("standard sync ignores partially-created branch products with an extra empty SKU", () => {
  const malformed = {
    itemId: 1,
    skus: [
      { skuNo: null },
      { skuNo: "2000000000069" },
      { skuNo: "2000000000099" },
      { skuNo: "2000000000198" },
    ],
  };
  const exact = {
    itemId: 2,
    skus: [
      { skuNo: "2000000000198" },
      { skuNo: "2000000000069" },
      { skuNo: "2000000000099" },
    ],
  };

  assert.equal(
    selectExactStandardBranchGroup([malformed, exact], groupedToySkus)?.itemId,
    2,
  );
});

test("standard sync replaces a stale stored category with Youzan's live uncategorized category", () => {
  const categories = [
    { id: 90747747, name: "未分类" },
    { id: 148583127, name: "动漫玩具" },
  ];

  assert.deepEqual(selectValidYouzanRetailCategory(categories, 12345), categories[0]);
  assert.deepEqual(selectValidYouzanRetailCategory(categories, 148583127), categories[1]);
});

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

test("HQ SPU lookup uses Youzan's exact code filters instead of scanning page one", () => {
  assert.deepEqual(buildHqSpuLookupParams(" 2009876212904 "), [
    { page_no: 1, page_size: 20, spu_codes: ["2009876212904"] },
    { page_no: 1, page_size: 20, sku_codes: ["2009876212904"] },
    { page_no: 1, page_size: 20 },
  ]);
});

test("HQ lookup never falls back to a same-name SPU when an exact code was requested", () => {
  const rows = [
    {
      spu_id: 5071222203,
      spu_code: "BM507122220383",
      product_name: "古美术 9.9元",
      skus: [{ sku_id: 390105648, sku_code: "BM507122220383" }],
    },
    {
      spu_id: 6232299828,
      spu_code: "2008525174570",
      product_name: "古美术 9.9元",
      skus: [{ sku_id: 528876422, sku_code: "2008525174570" }],
    },
  ];

  assert.equal(
    selectHqSpuRemoteIdentity(rows, {
      code: "2009066940334",
      name: "古美术 9.9元",
    }),
    null,
  );
  assert.deepEqual(
    selectHqSpuRemoteIdentity(rows, { spuId: 5071222203 }),
    {
      spuId: 5071222203,
      spuCode: "BM507122220383",
      skuId: 390105648,
      skuCode: "BM507122220383",
    },
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
  assert.match(route, /groupStandardCatalogSkus/);
  assert.match(route, /group\.skus\[0\]\.id/);
  assert.match(route, /sku_code, barcode, name/);
  assert.doesNotMatch(route, /for \(const sku of skus\)/);
  assert.doesNotMatch(route, /da06cdae-5ec1-4749-8dcb-dc972cfd05c9/);
});

test("standard catalog runner retries transient batch failures without advancing the offset", () => {
  const runner = readFileSync("scripts/sync-standard-catalog-youzan.mjs", "utf8");
  assert.match(runner, /STANDARD_SYNC_START_OFFSET/);
  assert.match(runner, /STANDARD_SYNC_BATCH_SIZE \?\? 10/);
  assert.match(runner, /const maxAttempts = 3/);
  assert.match(runner, /const text = await response\.text\(\)/);
  assert.match(runner, /if \(batchFailed > 0\) break;\s*offset = nextOffset/);
});

test("standard catalog keeps POS barcodes on branch SKUs and repairs stale HQ links", () => {
  const sync = readFileSync("src/lib/youzan-sync.functions.ts", "utf8");
  assert.match(sync, /scan_barcode: null/);
  assert.match(sync, /\.delete\(\)[\s\S]*\.eq\("role", "hq_spu"\)/);
  assert.doesNotMatch(sync, /buildStandardHqBarcodeFields/);
});

test("new HQ products stop lookup as soon as the created SPU is found", () => {
  const sync = readFileSync("src/lib/youzan-sync.functions.ts", "utf8");
  assert.match(sync, /if \(forceRefresh\)[\s\S]*if \(matched\)[\s\S]*return matched/);
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
  assert.match(server, /syncStandardGroupContainingSkuCore/);
  assert.doesNotMatch(server, /releaseSkuToBranchCore/);
  assert.doesNotMatch(server, /pushYouzanQuantityUpdate/);
});

test("grouped standard sync publishes the HQ item instead of recreating branch products", () => {
  const server = readFileSync("src/lib/standard-catalog-youzan-group.server.ts", "utf8");
  assert.match(server, /youzan\.item\.base\.get/);
  assert.match(server, /youzan\.item\.common\.update/);
  assert.match(server, /imageIds/);
  assert.match(server, /youzan\.item\.channel\.publish/);
  assert.doesNotMatch(server, /youzan\.retail\.open\.offline\.spu\.release/);
  assert.doesNotMatch(server, /youzan\.retail\.open\.offline\.spu\.update/);
  assert.doesNotMatch(server, /youzan\.item\.update\.delisting/);
});

test("branch stock failures invalidate stale links and listings", () => {
  const server = readFileSync("src/lib/youzan-offline-products.functions.ts", "utf8");
  assert.match(server, /status: "error",\s*role: "branch_stock"/);
  assert.match(server, /listing_status: "error"/);
  assert.match(server, /channel: "youzan_branch_offline"/);
});

test("existing branch links are revalidated against the live Youzan catalog", () => {
  const server = readFileSync("src/lib/youzan-offline-products.functions.ts", "utf8");
  assert.match(server, /const remoteExisting = await findExistingOfflineProduct/);
  assert.match(
    server,
    /for \(const displayStatus[\s\S]*findOfflineProductMatch\(queried\.rows, target\)[\s\S]*if \(matched\) return matched/,
  );
  assert.doesNotMatch(server, /canReuseOfflineBranchLink\(existingBranchLink\)/);
});
