import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ordinaryGatewayConfig } from "./ordinary-gateway-config";
import { createOrdinaryGatewayClient } from "./ordinary-gateway-client";
import {
  OrdinaryGatewayEvent,
  toDecodedNotification,
  verifyGatewayEventSignature,
} from "./ordinary-gateway-event";

const SECRET = "a".repeat(32);
const ENV = {
  ORDINARY_PAYMENT_GATEWAY_URL: "https://pay.example.com/",
  ORDINARY_PAYMENT_GATEWAY_TOKEN: "t".repeat(32),
  ORDINARY_PAYMENT_GATEWAY_EVENT_SECRET: SECRET,
};
const MERCHANT = { merchantId: "1749999844", appId: "wx9aef0738067286b3" };

function client(fetchImpl: typeof fetch) {
  return createOrdinaryGatewayClient({
    url: "https://pay.example.com",
    token: "t".repeat(32),
    ...MERCHANT,
    timeoutMs: 2000,
    fetchImpl,
  });
}
function response(status: number, body: unknown) {
  return new Response(body === undefined ? "" : JSON.stringify(body), { status });
}

describe("ordinaryGatewayConfig", () => {
  it("未配置任何网关变量时返回 null（保持旧模式）", () => {
    assert.equal(ordinaryGatewayConfig({}), null);
  });
  it("配置齐全时归一化 URL 与超时", () => {
    const config = ordinaryGatewayConfig(ENV);
    assert.equal(config?.url, "https://pay.example.com");
    assert.equal(config?.timeoutMs, 8000);
  });
  it("拒绝半套配置、http、弱凭据", () => {
    assert.throws(() => ordinaryGatewayConfig({ ORDINARY_PAYMENT_GATEWAY_URL: "https://a.b" }));
    assert.throws(() =>
      ordinaryGatewayConfig({ ...ENV, ORDINARY_PAYMENT_GATEWAY_URL: "http://a.b" }),
    );
    assert.throws(() => ordinaryGatewayConfig({ ...ENV, ORDINARY_PAYMENT_GATEWAY_TOKEN: "short" }));
  });
});

describe("createOrdinaryGatewayClient", () => {
  it("下单带幂等键并返回预支付凭据", async () => {
    let seen: Request | null = null;
    const gateway = client(async (input, init) => {
      seen = new Request(input as string, init);
      return response(200, {
        prepay_id: "wx-prepay-1",
        payment_payload: { package: "prepay_id=wx-prepay-1" },
      });
    });
    const created = await gateway.createPayment({
      orderNo: "SO20260908001",
      totalFen: 1290,
      openid: "o-1",
      description: "d",
    });
    assert.equal(created.prepay_id, "wx-prepay-1");
    assert.equal(seen!.headers.get("Idempotency-Key"), "SO20260908001");
  });

  it("下单超时/5xx 只报结果未知，绝不重复下单", async () => {
    let calls = 0;
    const gateway = client(async () => {
      calls += 1;
      return response(502, { code: "BAD_GATEWAY" });
    });
    await assert.rejects(
      gateway.createPayment({ orderNo: "SO1", totalFen: 100, openid: "o", description: "d" }),
      (error: { code?: string }) => error.code === "payment_result_unknown",
    );
    assert.equal(calls, 1);
  });

  it("退款超时同样只报结果未知", async () => {
    let calls = 0;
    const gateway = client(async () => {
      calls += 1;
      throw new Error("aborted");
    });
    await assert.rejects(
      gateway.refund({ orderNo: "SO1", refundNo: "RF1", totalFen: 100, refundFen: 100 }),
      (error: { code?: string }) => error.code === "payment_result_unknown",
    );
    assert.equal(calls, 1);
  });

  it("查单可安全重试，并把 404 映射成订单不存在", async () => {
    let calls = 0;
    const retrying = client(async () => {
      calls += 1;
      return calls === 1 ? response(500, { code: "X" }) : response(200, { trade_state: "SUCCESS" });
    });
    assert.deepEqual(await retrying.queryPayment("SO1"), { trade_state: "SUCCESS" });
    assert.equal(calls, 2);

    const missing = client(async () => response(404, { code: "ORDERNOTEXIST" }));
    await assert.rejects(
      missing.queryPayment("SO1"),
      (e: { code?: string }) => e.code === "ORDERNOTEXIST",
    );
    const missingRefund = client(async () => response(404, {}));
    await assert.rejects(
      missingRefund.queryRefund("RF1"),
      (e: { code?: string }) => e.code === "RESOURCE_NOT_EXISTS",
    );
  });
});

describe("verifyGatewayEventSignature", () => {
  const raw = JSON.stringify({ type: "payment.succeeded" });
  const ts = String(Math.floor(Date.now() / 1000));
  const sign = (body: string, timestamp: string, secret = SECRET) =>
    createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

  it("接受合法签名", () => {
    assert.equal(
      verifyGatewayEventSignature({
        rawBody: raw,
        timestamp: ts,
        signature: sign(raw, ts),
        secret: SECRET,
      }),
      true,
    );
  });
  it("拒绝改包体、换密钥、缺头与过期时间戳", () => {
    assert.equal(
      verifyGatewayEventSignature({
        rawBody: `${raw} `,
        timestamp: ts,
        signature: sign(raw, ts),
        secret: SECRET,
      }),
      false,
    );
    assert.equal(
      verifyGatewayEventSignature({
        rawBody: raw,
        timestamp: ts,
        signature: sign(raw, ts, "b".repeat(32)),
        secret: SECRET,
      }),
      false,
    );
    assert.equal(
      verifyGatewayEventSignature({ rawBody: raw, timestamp: ts, signature: null, secret: SECRET }),
      false,
    );
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    assert.equal(
      verifyGatewayEventSignature({
        rawBody: raw,
        timestamp: old,
        signature: sign(raw, old),
        secret: SECRET,
      }),
      false,
    );
  });
});

describe("toDecodedNotification", () => {
  const payment = {
    type: "payment.succeeded",
    event_id: "evt-000001",
    merchant_id: MERCHANT.merchantId,
    app_id: MERCHANT.appId,
    out_trade_no: "SO20260908001",
    transaction_id: "4200001234202609081",
    amount: { total: 1290, currency: "CNY" },
    payer: { openid: "o-abc" },
    success_time: "2026-09-08T15:00:00+08:00",
  };

  it("支付事件映射为微信同构结构", () => {
    const decoded = toDecodedNotification(OrdinaryGatewayEvent.parse(payment), MERCHANT);
    assert.equal(decoded.eventType, "TRANSACTION.SUCCESS");
    assert.equal(decoded.id, "gw:evt-000001");
    assert.equal(decoded.data["trade_state"], "SUCCESS");
    assert.deepEqual(decoded.data["amount"], { total: 1290, currency: "CNY" });
  });

  it("商户号或 AppID 不符直接拒绝", () => {
    assert.throws(() =>
      toDecodedNotification(
        OrdinaryGatewayEvent.parse({ ...payment, merchant_id: "1000000000" }),
        MERCHANT,
      ),
    );
    assert.throws(() =>
      toDecodedNotification(OrdinaryGatewayEvent.parse(payment), {
        ...MERCHANT,
        appId: "wxffffffffffffffff",
      }),
    );
  });

  it("拒绝非 CNY、非整数分、缺失字段", () => {
    assert.throws(() =>
      OrdinaryGatewayEvent.parse({ ...payment, amount: { total: 1290, currency: "USD" } }),
    );
    assert.throws(() =>
      OrdinaryGatewayEvent.parse({ ...payment, amount: { total: 12.9, currency: "CNY" } }),
    );
    assert.throws(() => OrdinaryGatewayEvent.parse({ ...payment, payer: {} }));
  });

  it("退款事件按状态映射", () => {
    const base = {
      type: "refund.updated",
      event_id: "evt-000002",
      merchant_id: MERCHANT.merchantId,
      app_id: MERCHANT.appId,
      out_trade_no: "SO20260908001",
      out_refund_no: "RF20260908001",
      transaction_id: "4200001234202609081",
      refund_id: "50300000000000001",
      amount: { total: 1290, refund: 1290, currency: "CNY" },
    };
    for (const [status, expected] of [
      ["SUCCESS", "REFUND.SUCCESS"],
      ["ABNORMAL", "REFUND.ABNORMAL"],
      ["CLOSED", "REFUND.CLOSED"],
    ] as const) {
      const decoded = toDecodedNotification(
        OrdinaryGatewayEvent.parse({
          ...base,
          refund_status: status,
          success_time: "2026-09-08T15:10:00+08:00",
        }),
        MERCHANT,
      );
      assert.equal(decoded.eventType, expected);
    }
  });
});
