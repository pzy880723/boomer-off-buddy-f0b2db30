import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildOfflineSkuReleaseInput,
  buildOfflineStockQueueRow,
  buildOfflineProductQueryParams,
  buildOfflineProductReleaseParams,
  buildOfflineProductLookupTerms,
  findOfflineProductMatch,
  normalizeYouzanProductCode,
  parseOfflineProductRows,
} from "./youzan-offline-products.server";

describe("youzan offline products", () => {
  test("query pagination never exceeds the documented 3300 window", () => {
    assert.throws(() => buildOfflineProductQueryParams({ pageNo: 34, pageSize: 100 }));
    assert.deepEqual(buildOfflineProductQueryParams({ pageNo: 33, pageSize: 100 }), {
      page_no: 33,
      page_size: 100,
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
    assert.deepEqual(params.sub_kdt_status_param.sale_up_kdt_ids, [233, 666]);
    assert.equal(params.stocks[0].sell_stock_count, "1");
    assert.equal(params.picture, JSON.stringify([{ url: "https://img.yzcdn.cn/a.webp" }]));
  });

  test("ERP SKU maps to the official offline release payload without sell_channel_id", () => {
    const input = buildOfflineSkuReleaseInput({
      sku: {
        name: "昭和小钵",
        skuCode: "SKU-JP-001",
        priceYuan: 168,
        imageUrls: ["https://img.yzcdn.cn/a.webp"],
      },
      categoryId: 345202,
      branchKdtIds: [233, 666],
      stock: 1,
    });

    assert.deepEqual(input.saleUpKdtIds, [233, 666]);
    assert.equal(input.spuCode, "SKUJP001");
    assert.equal(input.skuCenterCode, "SKUJP001");
    assert.equal(input.stock.skuNo, "SKUJP001");
    assert.equal(input.unit, "件");
  });

  test("release lookup checks a Youzan-safe code before the product title", () => {
    assert.equal(normalizeYouzanProductCode("SKU-JP-260712-C8FG"), "SKUJP260712C8FG");
    assert.deepEqual(
      buildOfflineProductLookupTerms({
        skuCode: "SKU-JP-260712-C8FG",
        name: "test2",
      }),
      ["SKUJP260712C8FG", "test2"],
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
});
