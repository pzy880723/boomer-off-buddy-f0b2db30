import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("online orders use payment-aware state, explicit source, refresh and error feedback", () => {
  const page = read("routes/orders.online.tsx");
  assert.match(page, /title="线上订单"/);
  assert.match(page, /onlineOrderState\(row\)/);
  assert.match(page, /row.source_label/);
  assert.match(page, /value: "refunded", label: "已退款"/);
  assert.match(page, /refetchInterval: 15_000/);
  assert.match(page, /query.isError/);
  assert.match(page, /已退款 · 停止履约/);
  const query = read("lib/commerce-operations.functions.ts");
  assert.match(query, /\.neq\("source_channel", "pos"\)/);
  assert.match(query, /source_channel,metadata,/);
  assert.match(query, /source_label: orderSourceLabel/);
  assert.match(query, /payment_status === "unpaid" && order.order_status === "pending_payment"/);
});

test("create order preserves production checkout guards and records an optional explicit source", () => {
  const route = read("routes/api/public/storefront/orders.ts");
  assert.match(route, /source_platform: z.enum\(\["miniapp", "app", "web"\]\).optional\(\)/);
  assert.match(route, /platform: body.source_platform/);
  assert.match(route, /order_source_pending/);
  for (const guard of ["checkout_not_enabled", "zero_payable_unsupported", "coupon_unavailable", "shipping_quote_changed", "delivery_unavailable"]) {
    assert.ok(route.includes(guard), guard);
  }
});

test("express replay conflicts with pickup and flash, and payment-not-ready copy is neutral", () => {
  const route = read("routes/api/public/storefront/orders.ts");
  assert.match(route, /createdMethod === "pickup" \|\| createdMethod === "flash"/);
  assert.match(route, /fulfillment_method_conflict/);
  const payCopy = route.match(/支付服务暂不可用，请稍后重试/g) ?? [];
  assert.equal(payCopy.length, 2);
  assert.ok(!route.includes("门店自提暂未开放"));
  assert.ok(!route.includes("同城闪送暂未开放"));
});

test("mini-program source is only persisted after validated ordinary payment setup", () => {
  const route = read("routes/api/public/storefront/payments.ts");
  assert.ok(route.indexOf("await recordOrderOrigin") > route.indexOf("await startOrdinaryPayment"));
  assert.match(route, /evidence: "verified_miniapp_payment"/);
  assert.match(route, /miniAppId: auth.customer.wechatMiniAppId/);
});
