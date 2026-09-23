import assert from "node:assert/strict";
import { test } from "node:test";
import { onlineOrderState, orderSourceLabel } from "./online-order-presentation.ts";

test("successful full refund overrides stale fulfillment and closed status", () => {
  for (const order_status of ["processing", "completed", "after_sale", "closed"]) {
    assert.deepEqual(onlineOrderState({ order_status, payment_status: "refunded" }), {
      view: "refunded", label: "已退款", tone: "neutral",
    });
  }
});
test("partial and pending refunds are not full refunds", () => {
  assert.equal(onlineOrderState({order_status:"processing",payment_status:"partially_refunded"}).label,"部分退款");
  assert.equal(onlineOrderState({order_status:"processing",payment_status:"refund_pending"}).label,"退款中");
  assert.equal(onlineOrderState({order_status:"processing",payment_status:"paid"}).view,"fulfillment");
});
test("unpaid cancellation and unknown states never become actionable fulfillment", () => {
  assert.equal(onlineOrderState({order_status:"cancelled",payment_status:"unpaid"}).view,"cancelled");
  assert.equal(onlineOrderState({order_status:"new_state",payment_status:"paid"}).view,"unknown");
});
test("source comes from order origin, not payment method or delivery method", () => {
  assert.equal(orderSourceLabel({source_channel:"storefront",metadata:{}}),"自营线上 · 来源未记录");
  for (const [platform,label] of [["miniapp","小程序"],["app","APP"],["web","网页商城"],["delivery","外卖订单"]]) {
    assert.equal(orderSourceLabel({source_channel:"storefront",metadata:{sales_origin:{platform}}}),label);
  }
  assert.equal(orderSourceLabel({source_channel:"youzan",metadata:{sales_origin:{platform:"app"}}}),"有赞");
  assert.equal(orderSourceLabel({source_channel:"storefront",metadata:{provider:"wechat",fulfillment_method:"shipping"}}),"自营线上 · 来源未记录");
  assert.equal(orderSourceLabel({source_channel:"storefront",metadata:{sales_origin:{platform:"<script>"}}}),"自营线上 · 来源未记录");
});
