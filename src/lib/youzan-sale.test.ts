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
  test("refunded orders and lines never deduct stock", async () => {
    for (const lineOnly of [false, true]) {
      const trade = structuredClone(offlineTrade);
      Object.assign(lineOnly ? trade.full_order_info.orders[0] : trade.full_order_info.order_info, { refund_state: 2 });
      const result = await processYouzanSale({ trade, shopId: "shop-1", adapter: {
        findLocationId: async () => "loc-1",
        findSkuId: async () => { throw Error("must not resolve refunded stock"); },
        commitSale: async () => { throw Error("must not deduct refunded stock"); },
      } });
      assert.equal(result.processed, 0);
    }
  });
  test("passes the real sale store id into location resolution and refuses a mismatch", async () => {
    await assert.rejects(processYouzanSale({ trade: offlineTrade, shopId: "wrong-shop", adapter: {
      findLocationId: async (_shop, kdt) => {
        assert.equal(kdt, 187395218);
        throw Error("销售门店与订单不一致");
      },
      findSkuId: async () => { throw Error("must not resolve a mismatched order"); },
      commitSale: async () => { throw Error("must not commit a mismatched order"); },
    } }), /销售门店与订单不一致/);
  });
  test("unpaid or cancelled trades cannot deduct stock", async () => {
    for (const status of ["WAIT_BUYER_PAY", "TRADE_CLOSED", ""]) {
      const trade = structuredClone(offlineTrade);
      trade.full_order_info.order_info.status = status;
      const unexpected = async (): Promise<never> => { throw Error("must not reconcile unpaid trade"); };
      const result = await processYouzanSale({ trade, shopId: "shop-1", adapter: {
        findLocationId: unexpected, findSkuId: unexpected, commitSale: unexpected,
      } });
      assert.equal(result.processed, 0);
    }
  });

  test("offline sales without a store location cannot deduct headquarters stock", async () => {
    await assert.rejects(processYouzanSale({ trade: offlineTrade, shopId: "shop-1", adapter: {
      findLocationId: async () => null,
      findSkuId: async () => "sku-1",
      commitSale: async () => { throw Error("must not commit without location"); },
    } }), /销售门店未绑定库位/);
  });
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
      gated: {},
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

describe("stable order-line idempotency", () => {
  const trade = (orders: unknown[]) => ({
    full_order_info: {
      order_info: { tid: "E1", status: "TRADE_SUCCESS", offline_id: 212291308 },
      source_info: { is_offline_order: true },
      orders,
    },
  });
  const a = { oid: "3170827559510736957", item_id: 6480588312, sku_id: 0, outer_sku_id: "2002535897511", num: 1 };
  const b = { oid: "3170827559510736955", item_id: 6411694159, sku_id: 26247576379, outer_sku_id: "2000047289374", num: 2 };
  async function keys(orders: unknown[]) {
    const commits: Array<{ sourceOrderId: string; legacySourceOrderId: string | null; skuId: string }> = [];
    await processYouzanSale({ trade: trade(orders), shopId: "shop", adapter: {
      findLocationId: async () => "loc",
      findSkuId: async ({ itemId }) => `sku-${itemId}`,
      commitSale: async (i) => { commits.push(i as never); return { ok: true }; },
    } });
    return commits;
  }
  test("keys use the Youzan line oid, so line reordering cannot shift deductions", async () => {
    const one = await keys([a, b]);
    const two = await keys([b, a]);
    const bySku = (c: typeof one) => Object.fromEntries(c.map((x) => [`${x.skuId}:${x.sourceOrderId}`, true]));
    assert.deepEqual(bySku(one), bySku(two));
    assert.deepEqual(one.map((c) => c.sourceOrderId), [
      "E1#oid:3170827559510736957#0", "E1#oid:3170827559510736955#0", "E1#oid:3170827559510736955#1",
    ]);
  });
  test("each unit also carries the legacy positional key so already-processed lines are not deducted twice", async () => {
    const c = await keys([a, b]);
    assert.deepEqual(c.map((x) => x.legacySourceOrderId), ["E1#0#0", "E1#1#0", "E1#1#1"]);
  });
});
