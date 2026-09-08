import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PaymentRouteError,
  assertSplitSettlementReady,
  ordinaryProfitSharePlan,
  resolveOrderChannel,
  resolvePaymentChannel,
} from "./payment-route";

const ordinaryPayment = {
  id: "p1",
  order_id: "o1",
  payment_channel: "ordinary_wechat",
  merchant_snapshot: {
    mode: "ordinary_wechat",
    merchant_id: "1749999844",
    app_id: "wx9aef0738067286b3",
  },
};

describe("payment channel routing is snapshot driven", () => {
  it("普通商户历史单：全局切回分账后仍按普通商户退款", () => {
    process.env.STOREFRONT_PAYMENT_MODE = "legacy";
    assert.equal(resolvePaymentChannel(ordinaryPayment), "ordinary_wechat");
  });

  it("分账历史单：全局切到普通商户后仍走原分账通道退款/回退", () => {
    process.env.STOREFRONT_PAYMENT_MODE = "ordinary_wechat";
    assert.equal(
      resolvePaymentChannel({ id: "p2", order_id: "o2", payment_channel: "legacy" }),
      "legacy_split",
    );
    assert.equal(resolvePaymentChannel({ id: "p3", order_id: "o3" }), "legacy_split");
  });

  it("普通商户快照缺失时拒绝路由，不猜通道", () => {
    assert.throws(
      () => resolvePaymentChannel({ id: "p4", order_id: "o4", payment_channel: "ordinary_wechat" }),
      PaymentRouteError,
    );
  });

  it("未支付订单按下单时固化的 payment_route 路由", () => {
    assert.equal(resolveOrderChannel({ id: "o5", payment_route: null }), "legacy_split");
    assert.equal(
      resolveOrderChannel({
        id: "o6",
        payment_route: {
          version: 1,
          mode: "ordinary_wechat",
          merchant_id: "1749999844",
          app_id: "wx9aef0738067286b3",
        },
      }),
      "ordinary_wechat",
    );
    assert.throws(
      () => resolveOrderChannel({ id: "o7", payment_route: { mode: "ordinary_wechat" } }),
      PaymentRouteError,
    );
    assert.throws(
      () => resolveOrderChannel({ id: "o8", payment_route: { mode: "aggregator" } }),
      PaymentRouteError,
    );
  });
});

describe("split settlement never degrades to headquarters collection", () => {
  it("门店主体缺失时报错而不是总部代收", () => {
    assert.throws(
      () => assertSplitSettlementReady({ locationIds: ["a", "b"], readyLocationIds: ["a"] }),
      /门店结算主体未就绪：b/,
    );
  });

  it("全部就绪时通过", () => {
    assert.equal(
      assertSplitSettlementReady({ locationIds: ["a"], readyLocationIds: ["a", "b"] }),
      undefined,
    );
  });
});

describe("ordinary cross-store orders keep line attribution without profit share", () => {
  it("跨门店普通商户订单不发起微信分账，仅保留行级归属", () => {
    const plan = ordinaryProfitSharePlan(
      {
        id: "o9",
        payment_route: {
          mode: "ordinary_wechat",
          merchant_id: "1749999844",
          app_id: "wx9aef0738067286b3",
        },
      },
      ["loc-b", "loc-a", "loc-b"],
    );
    assert.deepEqual(plan, {
      profit_share: false,
      sub_orders: [],
      fulfillment_location_ids: ["loc-a", "loc-b"],
    });
  });
});
