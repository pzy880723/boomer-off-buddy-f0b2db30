import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildBranchItemShelfRequest,
  buildOfflineSkuReleaseInput,
  buildOfflineStockQueueRow,
  buildOfflineProductQueryParams,
  buildOfflineProductReleaseParams,
  buildOfflineProductLookupTerms,
  buildOfflineChannelListingRow,
  buildOfflineSkuIdentity,
  findOfflineProductMatch,
  normalizeYouzanProductCode,
  parseOfflineProductRows,
  resolveOfflineReleaseSourceImages,
} from "./youzan-offline-products.server";

describe("youzan offline products", () => {
  test("branch shelf changes use the branch item listing API contract", () => {
    assert.deepEqual(
      buildBranchItemShelfRequest({
        itemId: 6128079637,
        online: false,
      }),
      {
        method: "youzan.item.update.delisting",
        version: "3.0.1",
        params: { item_id: 6128079637 },
      },
    );
    assert.deepEqual(
      buildBranchItemShelfRequest({
        itemId: 6128079637,
        online: true,
      }),
      {
        method: "youzan.item.update.listing",
        version: "3.0.0",
        params: { item_id: 6128079637 },
      },
    );
    assert.throws(() => buildBranchItemShelfRequest({ itemId: 0, online: true }));
  });

  test("query pagination never exceeds the documented 3300 window", () => {
    assert.throws(() => buildOfflineProductQueryParams({ pageNo: 1, pageSize: 51 }));
    assert.throws(() => buildOfflineProductQueryParams({ pageNo: 67, pageSize: 50 }));
    assert.deepEqual(buildOfflineProductQueryParams({ pageNo: 66, pageSize: 50 }), {
      page_no: 66,
      page_size: 50,
    });
  });

  test("query parser keeps channel ids but ignores deprecated sell stock", () => {
    const rows = parseOfflineProductRows({
      data: {
        offline_spus: [
          {
            item_id: 518408566,
            title: "昭和小钵",
            spu_no: "BO-001",
            is_display: 1,
            sell_stock_count: "99",
            sku_models: [{ sku_id: 123, sku_no: "BO-001-A", price: "168" }],
          },
        ],
      },
    });
    assert.deepEqual(rows, [
      {
        itemId: 518408566,
        title: "昭和小钵",
        spuNo: "BO-001",
        isDisplay: true,
        skus: [{ skuId: 123, skuNo: "BO-001-A", price: 168 }],
      },
    ]);
  });

  test("release uses stable codes and explicit branch scope", () => {
    const params = buildOfflineProductReleaseParams({
      title: "昭和小钵",
      categoryId: 345202,
      unit: "件",
      priceYuan: 168,
      imageUrls: ["https://img.yzcdn.cn/a.webp"],
      spuCode: "BO-001",
      skuCenterCode: "BO-001-A",
      saleUpKdtIds: [233, 666],
      saleDownKdtIds: [],
      stock: {
        skuNo: "BO-001-A",
        relatedSpuCode: "BO-001",
        relatedSkuCode: "BO-001-A",
        sellStockCount: 1,
      },
    });
    assert.equal(params.all_batch_operate, -1);
    assert.equal(params.price, "16800");
    assert.equal(params.retail_price, "16800");
    assert.deepEqual(params.sub_kdt_status_param.sale_up_kdt_ids, [233, 666]);
    assert.equal(params.stocks[0].price, "16800");
    assert.equal(params.stocks[0].sell_stock_count, "1");
    assert.equal(params.picture, JSON.stringify([{ url: "https://img.yzcdn.cn/a.webp" }]));
  });

  test("release keeps the minimum retail price at one fen", () => {
    const params = buildOfflineProductReleaseParams({
      title: "联调测试商品",
      categoryId: 345202,
      unit: "件",
      priceYuan: 0.01,
      imageUrls: ["https://img.yzcdn.cn/a.webp"],
      spuCode: "E2E001",
      skuCenterCode: "E2E001",
      saleUpKdtIds: [233],
      saleDownKdtIds: [],
      stock: {
        skuNo: "E2E001",
        relatedSpuCode: "E2E001",
        relatedSkuCode: "E2E001",
        sellStockCount: 1,
      },
    });

    assert.equal(params.price, "1");
    assert.equal(params.retail_price, "1");
    assert.equal(params.stocks[0].price, "1");
    assert.equal(params.stocks[0].min_retail_price, "1");
    assert.equal(params.stocks[0].max_retail_price, "1");
  });

  test("branch release uses HQ relation codes while preserving the ERP POS barcode", () => {
    const input = buildOfflineSkuReleaseInput({
      sku: {
        name: "昭和小钵",
        scanCode: "2009876212904",
        hqSpuCode: "BM507122220383",
        hqSkuCode: "BM507122220383",
        priceYuan: 168,
        imageUrls: ["https://img.yzcdn.cn/a.webp"],
      },
      categoryId: 345202,
      branchKdtIds: [233, 666],
      stock: 1,
    });

    assert.deepEqual(input.saleUpKdtIds, [233, 666]);
    assert.equal(input.spuCode, "BM507122220383");
    assert.equal(input.skuCenterCode, "BM507122220383");
    assert.equal(input.stock.skuNo, "2009876212904");
    assert.equal(input.stock.relatedSpuCode, "BM507122220383");
    assert.equal(input.stock.relatedSkuCode, "BM507122220383");
    assert.equal(input.unit, "件");
  });

  test("standard products use the ERP barcode as the Youzan POS scan code", () => {
    assert.deepEqual(
      buildOfflineSkuIdentity({
        id: "11111111-1111-1111-1111-111111111111",
        skuScope: "standard",
        skuCode: "SKU-STD-AT",
        barcode: "2008685091625",
        name: "古美术",
        priceTier: 6.9,
      }),
      { code: "2008685091625", name: "古美术 6.9元" },
    );
  });

  test("standard products without photos use the public BOOMER fallback image", () => {
    assert.deepEqual(
      resolveOfflineReleaseSourceImages({
        skuScope: "standard",
        imageUrl: null,
        imagePaths: [],
        publicOrigin: "https://erp.boomeroff.com",
      }),
      ["https://erp.boomeroff.com/m-icon-512.png"],
    );
    assert.deepEqual(
      resolveOfflineReleaseSourceImages({
        skuScope: "custom",
        imageUrl: null,
        imagePaths: [],
        publicOrigin: "https://erp.boomeroff.com",
      }),
      [],
    );
  });

  test("release lookup preserves the exact ERP code before normalized fallbacks", () => {
    assert.equal(normalizeYouzanProductCode("SKU-JP-260712-C8FG"), "SKUJP260712C8FG");
    assert.deepEqual(
      buildOfflineProductLookupTerms({
        skuCode: "SKU-JP-260712-C8FG",
        name: "test2",
      }),
      ["SKU-JP-260712-C8FG", "SKUJP260712C8FG", "test2"],
    );
  });

  test("recovery matches a remote code with or without separators", () => {
    const rows = parseOfflineProductRows({
      data: {
        offline_spus: [
          {
            item_id: 6128079637,
            title: "联调测试商品",
            spu_no: "SKUXX260803VZ42",
            is_display: 1,
            sku_models: [{ sku_id: 26228487296, sku_no: "", price: "0.01" }],
          },
        ],
      },
    });

    assert.equal(
      findOfflineProductMatch(rows, {
        skuCode: "SKU-XX-260803-VZ42",
        name: "联调测试商品",
      })?.itemId,
      6128079637,
    );
  });

  test("recovery accepts a unique title when Youzan rewrites the product code", () => {
    const rows = parseOfflineProductRows({
      data: {
        offline_spus: [
          {
            item_id: 4870205046,
            title: "test2",
            spu_no: "P260713231105076",
            is_display: 1,
            sku_models: [{ sku_id: 15039602491, sku_no: "", price: "55" }],
          },
        ],
      },
    });

    const matched = findOfflineProductMatch(rows, {
      skuCode: "SKU-JP-260712-C8FG",
      name: "test2",
    });
    assert.equal(matched?.itemId, 4870205046);
    assert.equal(matched?.skus[0]?.skuId, 15039602491);
  });

  test("recovered branch listings reset failed stock sync tasks", () => {
    const row = buildOfflineStockQueueRow({
      skuId: "ee2e611e-94d2-4658-b992-63dc25581378",
      shopId: "da06cdae-5ec1-4749-8dcb-dc972cfd05c9",
      locationId: "7111b585-7d7f-4777-b4ae-61ce2b868f78",
      targetStock: 1,
    });
    assert.equal(row.status, "pending");
    assert.equal(row.target_stock, 1);
    assert.equal(row.last_error, null);
  });

  test("unlimited standard stock keeps the mirror target instead of recalculating local stock", () => {
    const row = buildOfflineStockQueueRow({
      skuId: "11111111-1111-1111-1111-111111111111",
      shopId: "22222222-2222-2222-2222-222222222222",
      locationId: null,
      targetStock: 9999,
    });
    assert.equal(row.location_id, null);
    assert.equal(row.target_stock, 9999);
  });

  test("offline publication mirrors the real branch ids into the unified channel listing", () => {
    assert.deepEqual(
      buildOfflineChannelListingRow({
        skuId: "ee2e611e-94d2-4658-b992-63dc25581378",
        shopId: "da06cdae-5ec1-4749-8dcb-dc972cfd05c9",
        hqSpuId: 4964712644,
        itemId: 6128079637,
        skuIdRemote: 26228487296,
        stock: 1,
        recovered: true,
      }),
      {
        sku_id: "ee2e611e-94d2-4658-b992-63dc25581378",
        channel: "youzan_branch_offline",
        shop_id: "da06cdae-5ec1-4749-8dcb-dc972cfd05c9",
        external_spu_id: "4964712644",
        external_item_id: "6128079637",
        external_sku_id: "26228487296",
        listing_status: "published",
        stock_mode: "absolute",
        last_stock: 1,
        last_error: null,
        extra: { source: "offline.spu.query" },
      },
    );
  });
});
