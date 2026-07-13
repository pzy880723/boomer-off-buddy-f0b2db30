import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractYouzanSale, processYouzanSale, type YouzanSaleAdapter } from "./youzan-sale.server";

const offlineTrade = {
  full_order_info: {
    order_info: {
      tid: "E20260712123357064106193",
      status: "TRADE_SUCCESS",
      offline_id: 187395218,
    },
    source_info: {
      is_offline_order: true,
      biz_source: "ANDROID-RETAILHD-8.51.1",
    },
    orders: [
      {
        item_id: 4520025901,
        sku_id: 14955310725,
        sku_no: "BM260117240727666",
        outer_sku_id: "P260117140786910",
        num: 2,
      },
    ],
  },
};

describe("youzan sale reconciliation", () => {
  test("extracts full trade details and classifies an offline store sale", () => {
    assert.deepEqual(extractYouzanSale(offlineTrade), {
      tid: "E20260712123357064106193",
      status: "TRADE_SUCCESS",
      sourceChannel: "youzan_branch_offline",
      targetKdtId: 187395218,
      items: [
        {
          itemId: 4520025901,
          quantity: 2,
          remoteSkuId: 14955310725,
          lookupCodes: ["BM260117240727666", "P260117140786910"],
        },
      ],
    });
  });

  test("classifies a web order as an online sale", () => {
    const trade = structuredClone(offlineTrade);
    trade.full_order_info.source_info.is_offline_order = false;
    trade.full_order_info.source_info.biz_source = "WECHAT";
    Object.assign(trade.full_order_info.order_info, {
      offline_id: null,
      node_kdt_id: 187395218,
    });

    const sale = extractYouzanSale(trade);
    assert.equal(sale?.sourceChannel, "youzan_online");
    assert.equal(sale?.targetKdtId, 187395218);
  });

  test("commits every sold unit with a stable idempotency key", async () => {
    const commits: Array<Record<string, unknown>> = [];
    const adapter: YouzanSaleAdapter = {
      findLocationId: async () => "loc-1",
      findSkuId: async () => "sku-1",
      commitSale: async (input) => {
        commits.push(input);
        return { ok: true, idempotent: false };
      },
    };

    const result = await processYouzanSale({
      trade: offlineTrade,
      shopId: "shop-1",
      adapter,
    });

    assert.deepEqual(result, {
      tid: "E20260712123357064106193",
      processed: 2,
      idempotent: 0,
      unmatched: 0,
      failed: 0,
    });
    assert.deepEqual(
      commits.map((row) => row.sourceOrderId),
      ["E20260712123357064106193#0#0", "E20260712123357064106193#0#1"],
    );
  });

  test("reports an unmatched item without pretending inventory was deducted", async () => {
    const adapter: YouzanSaleAdapter = {
      findLocationId: async () => "loc-1",
      findSkuId: async () => null,
      commitSale: async () => {
        throw new Error("must not commit an unmatched item");
      },
    };

    const result = await processYouzanSale({
      trade: offlineTrade,
      shopId: "shop-1",
      adapter,
    });

    assert.equal(result.unmatched, 2);
    assert.equal(result.processed, 0);
  });
});
