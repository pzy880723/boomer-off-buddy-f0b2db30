import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  buildOutTradeNo,
  callbackAmountMatches,
  canTransitionPosPayment,
  detectAuthCodeProvider,
  isClosablePosPaymentStatus,
  isPosPaymentExpired,
  mapAlipayTradeStatus,
  mapWechatTradeState,
  toMinorUnits,
} from "./pos-scan-payment";

const posRoot = new URL("../../routes/api/public/pos/", import.meta.url);

describe("POS 扫码支付路由契约", () => {
  for (const file of [
    "payments.micropay.ts",
    "payments.qr-order.ts",
    "payments.$id.ts",
    "payments.$id.close.ts",
    "payments.callback.$provider.ts",
  ]) {
    test(`提供 ${file}`, () => {
      const url = new URL(file, posRoot);
      assert.equal(existsSync(url), true);
    });
  }

  test("收银端路由必须鉴权，回调路由必须验签", () => {
    for (const file of [
      "payments.micropay.ts",
      "payments.qr-order.ts",
      "payments.$id.ts",
      "payments.$id.close.ts",
    ]) {
      assert.match(readFileSync(new URL(file, posRoot), "utf8"), /authenticatePosUser/);
    }
    const callback = readFileSync(new URL("payments.callback.$provider.ts", posRoot), "utf8");
    assert.match(callback, /verifyWechatCallback/);
    assert.match(callback, /verifyAlipayCallback/);
    assert.match(callback, /callbackAmountMatches/);
  });

  test("金额由服务端重算，且不落明文付款码", () => {
    const orchestrator = readFileSync(
      new URL("../../server/pos-payment.server.ts", import.meta.url),
      "utf8",
    );
    assert.match(orchestrator, /recomputePayableAmount/);
    assert.match(orchestrator, /pos_complete_sale_v2/);
    assert.match(orchestrator, /auth_code_hash/);
    assert.doesNotMatch(orchestrator, /auth_code:\s*input\.authCode/);
    const micropay = readFileSync(new URL("payments.micropay.ts", posRoot), "utf8");
    assert.doesNotMatch(micropay, /amount:\s*body\.amount/);
    assert.match(micropay, /payment_not_configured/);
  });

  test("客扫只生成订单专属动态码", () => {
    const qr = readFileSync(new URL("payments.qr-order.ts", posRoot), "utf8");
    assert.match(qr, /wechatNative/);
    assert.match(qr, /alipayPrecreate/);
    assert.match(qr, /expires_at|expiresAt/);
  });
});

describe("POS 扫码支付状态与金额逻辑", () => {
  test("识别付款码归属", () => {
    assert.equal(detectAuthCodeProvider("134567890123456789"), "wechat");
    assert.equal(detectAuthCodeProvider("284567890123456789"), "alipay");
    assert.equal(detectAuthCodeProvider("abc"), null);
  });

  test("用户支付中不能当作失败", () => {
    assert.equal(mapWechatTradeState("USERPAYING"), "user_paying");
    assert.equal(mapWechatTradeState("SUCCESS"), "paid");
    assert.equal(mapAlipayTradeStatus("WAIT_BUYER_PAY"), "user_paying");
    assert.equal(mapAlipayTradeStatus("TRADE_SUCCESS"), "paid");
  });

  test("已支付不可被后续回调改写", () => {
    assert.equal(canTransitionPosPayment("paid", "failed"), false);
    assert.equal(canTransitionPosPayment("closed", "paid"), false);
    assert.equal(canTransitionPosPayment("pending", "user_paying"), true);
    assert.equal(isClosablePosPaymentStatus("paid"), false);
    assert.equal(isClosablePosPaymentStatus("user_paying"), true);
  });

  test("金额按分严格比对", () => {
    assert.equal(toMinorUnits(12.34), 1234);
    assert.equal(callbackAmountMatches(12.34, 1234), true);
    assert.equal(callbackAmountMatches(12.34, 1200), false);
  });

  test("商户订单号唯一且二维码会过期", () => {
    const a = buildOutTradeNo(new Date("2026-08-02T10:00:00Z"), "aaaaaaaa");
    const b = buildOutTradeNo(new Date("2026-08-02T10:00:00Z"), "bbbbbbbb");
    assert.notEqual(a, b);
    assert.equal(isPosPaymentExpired("2020-01-01T00:00:00Z"), true);
    assert.equal(isPosPaymentExpired(null), false);
  });
});
