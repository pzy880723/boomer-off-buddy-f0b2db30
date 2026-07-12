import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildOfflineProductQueryParams,
  buildOfflineProductReleaseParams,
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
});
