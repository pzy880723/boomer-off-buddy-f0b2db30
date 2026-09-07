import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, sign, verify, createCipheriv, randomBytes } from "node:crypto";
import { createWeChatPayClient } from "./wechat-ordinary-client";

// Ephemeral test keys only. No production credential or real network request.
const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
const apiKey = randomBytes(32);
const timestamp = String(Math.floor(Date.now() / 1000));
const config = {
  appId: "wx-test", merchantId: "1234567890", certificateSerial: "ABC123",
  privateKey: merchant.privateKey, wechatPublicKey: platform.publicKey,
  wechatPublicKeyId: "PUB_KEY_ID_TEST", apiV3Key: apiKey,
  notifyUrl: "https://payments.example.com/wechat/notify",
  refundNotifyUrl: "https://payments.example.com/wechat/refunds/notify",
};

function signedHeaders(raw: string, changes: Record<string, string> = {}) {
  return new Headers({
    "Wechatpay-Timestamp": timestamp, "Wechatpay-Nonce": "test-nonce",
    "Wechatpay-Serial": config.wechatPublicKeyId,
    "Wechatpay-Signature": sign("RSA-SHA256", Buffer.from(`${timestamp}\ntest-nonce\n${raw}\n`), platform.privateKey).toString("base64"),
    ...changes,
  });
}
function response(data: unknown, status = 200) {
  const raw = status === 204 ? "" : JSON.stringify(data);
  return new Response(status === 204 ? null : raw, { status, headers: signedHeaders(raw) });
}
function clientWith(data: unknown, status = 200) {
  const calls: { url: string; options: RequestInit & { headers: Record<string, string>; body?: string } }[] = [];
  const client = createWeChatPayClient({ ...config, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options: options as RequestInit & { headers: Record<string, string>; body?: string } }); return response(data, status);
  } });
  return { client, calls };
}
const order = { orderNo: "BO202609080001", totalFen: 16800, openid: "mini-openid", description: "中古瓷杯" };

test("ordinary prepay signs exact request and returns a separately signed mini-program payload", async () => {
  const { client, calls } = clientWith({ prepay_id: "wx-prepay" });
  const result = await client.createPayment(order);
  const { url, options } = calls[0];
  assert.equal(url, "https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi");
  assert.equal(options.redirect, "error");
  assert.ok(options.signal);
  const fields = Object.fromEntries([...options.headers.Authorization.matchAll(/(\w+)="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  assert.equal(fields.mchid, config.merchantId);
  assert.equal(fields.serial_no, config.certificateSerial);
  assert.ok(verify("RSA-SHA256", Buffer.from(`POST\n/v3/pay/transactions/jsapi\n${fields.timestamp}\n${fields.nonce_str}\n${options.body}\n`), merchant.publicKey, Buffer.from(fields.signature, "base64")));
  const body = JSON.parse(options.body!);
  assert.equal(body.mchid, config.merchantId);
  assert.deepEqual(body.amount, { total: 16800, currency: "CNY" });
  assert.equal(body.settle_info, undefined);
  assert.equal(body.sub_mchid, undefined);
  assert.equal("transaction_id" in result, false);
  assert.equal(result.prepay_id, "wx-prepay");
  const p = result.payment_payload;
  assert.equal(p.package, "prepay_id=wx-prepay");
  assert.equal(p.signType, "RSA");
  assert.ok(verify("RSA-SHA256", Buffer.from(`${config.appId}\n${p.timeStamp}\n${p.nonceStr}\n${p.package}\n`), merchant.publicKey, Buffer.from(p.paySign, "base64")));
});

test("rejects fractional/invalid amounts before any network request", async () => {
  const { client, calls } = clientWith({});
  for (const totalFen of [0, -1, 1.2, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(client.createPayment({ ...order, totalFen }), /amount/i);
  }
  assert.equal(calls.length, 0);
});

test("rejects tampered responses and unknown verification keys", async () => {
  for (const headers of [signedHeaders("different-body"), signedHeaders("{}", { "Wechatpay-Serial": "OTHER" })]) {
    const client = createWeChatPayClient({ ...config, fetchImpl: async () => new Response("{}", { headers }) });
    await assert.rejects(client.createPayment(order), /signature|key/i);
  }
});

test("payment query uses the original merchant and signs the query string", async () => {
  const { client, calls } = clientWith({ trade_state: "NOTPAY" });
  await client.queryPayment(order.orderNo);
  assert.equal(calls[0].url, `https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/${order.orderNo}?mchid=${config.merchantId}`);
  assert.equal(calls[0].options.body, undefined);
  const f = Object.fromEntries([...calls[0].options.headers.Authorization.matchAll(/(\w+)="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const u = new URL(calls[0].url);
  assert.ok(verify("RSA-SHA256", Buffer.from(`GET\n${u.pathname}${u.search}\n${f.timestamp}\n${f.nonce_str}\n\n`), merchant.publicKey, Buffer.from(f.signature, "base64")));
});

test("refund keeps caller's stable refund number and uses integer fen", async () => {
  const { client, calls } = clientWith({ status: "PROCESSING", refund_id: "refund-test" });
  await client.refund({ orderNo: order.orderNo, refundNo: "REFUND0001", refundFen: 5000, totalFen: 16800 });
  const body = JSON.parse(calls[0].options.body!);
  assert.equal(body.out_refund_no, "REFUND0001");
  assert.deepEqual(body.amount, { refund: 5000, total: 16800, currency: "CNY" });
  await assert.rejects(client.refund({ orderNo: order.orderNo, refundNo: "REFUND0001", refundFen: 20000, totalFen: 16800 }), /amount/i);
  assert.equal(calls.length, 1);
  await client.queryRefund("REFUND0001");
  assert.match(calls[1].url, /\/v3\/refund\/domestic\/refunds\/REFUND0001$/);
});

test("signed empty close-order response is supported", async () => {
  const { client, calls } = clientWith(null, 204);
  assert.equal(await client.closePayment(order.orderNo), null);
  assert.deepEqual(JSON.parse(calls[0].options.body!), { mchid: config.merchantId });
});
test("close rejects signed 200 or 202 instead of treating it as a confirmed close", async () => {
  for (const status of [200, 202]) {
    const { client } = clientWith({}, status);
    await assert.rejects(client.closePayment(order.orderNo), /close|204/i);
  }
});

function notification(transaction: Record<string, unknown> = {}) {
  const resource = { mchid: config.merchantId, appid: config.appId, out_trade_no: order.orderNo,
    transaction_id: "4200000001", trade_state: "SUCCESS", amount: { total: order.totalFen, currency: "CNY" }, ...transaction };
  return encryptedNotification(resource, "TRANSACTION.SUCCESS", "transaction");
}

function encryptedNotification(resource: unknown, eventType: string, originalType: string) {
  const nonce = "123456789012";
  const cipher = createCipheriv("aes-256-gcm", apiKey, Buffer.from(nonce));
  cipher.setAAD(Buffer.from(originalType));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(resource)), cipher.final(), cipher.getAuthTag()]).toString("base64");
  const raw = JSON.stringify({ id: "event-1", event_type: eventType, resource_type: "encrypt-resource", resource: { original_type: originalType, algorithm: "AEAD_AES_256_GCM", nonce, associated_data: originalType, ciphertext } });
  return { raw, headers: signedHeaders(raw) };
}

test("verifies then decrypts payment notifications and matches the persisted order snapshot", () => {
  const { client } = clientWith({});
  const { raw, headers } = notification();
  const event = client.verifyPaymentNotification(raw, headers, order);
  assert.equal(event.id, "event-1");
  assert.equal(event.transaction.transaction_id, "4200000001");
});

test("rejects callback signature, freshness, merchant, app, currency and amount mismatches", () => {
  const { client } = clientWith({});
  const { raw, headers } = notification();
  assert.throws(() => client.verifyPaymentNotification(`${raw} `, headers, order), /signature/i);
  assert.throws(() => client.verifyPaymentNotification(raw, signedHeaders(raw, { "Wechatpay-Timestamp": "1" }), order), /timestamp/i);
  for (const data of [{ mchid: "OTHER" }, { appid: "OTHER" }, { out_trade_no: "OTHER" }, { amount: { total: 1, currency: "CNY" } }, { amount: { total: order.totalFen, currency: "USD" } }]) {
    const bad = notification(data);
    assert.throws(() => client.verifyPaymentNotification(bad.raw, bad.headers, order), /mismatch/i);
  }
});

test("network failure is an unknown payment outcome and never automatically retries", async () => {
  let calls = 0;
  const client = createWeChatPayClient({ ...config, fetchImpl: async () => { calls++; throw new Error("sensitive transport details"); } });
  await assert.rejects(client.createPayment(order), (error: unknown) => error instanceof Error && 'code' in error && error.code === "payment_result_unknown" && !error.message.includes("sensitive"));
  assert.equal(calls, 1);
});

test("configuration rejects insecure callback URLs and invalid API key lengths", () => {
  assert.throws(() => createWeChatPayClient({ ...config, notifyUrl: "http://example.com" }), /https/i);
  assert.throws(() => createWeChatPayClient({ ...config, apiV3Key: Buffer.from("short") }), /32/);
});

test("valid PEM configuration works without a production credential", async () => {
  const client = createWeChatPayClient({ ...config,
    privateKey: merchant.privateKey.export({ type: "pkcs8", format: "pem" }),
    wechatPublicKey: platform.publicKey.export({ type: "spki", format: "pem" }),
    fetchImpl: async () => response({ prepay_id: "test-pem" }),
  });
  assert.equal((await client.createPayment(order)).prepay_id, "test-pem");
});

test("unsigned HTTP errors do not become trusted payment errors", async () => {
  const client = createWeChatPayClient({ ...config, fetchImpl: async () => Response.json({ code: "ORDERPAID" }, { status: 400 }) });
  await assert.rejects(client.createPayment(order), /signature/);
});

test("signed provider errors expose a code but not personal details", async () => {
  const { client } = clientWith({ code: "PARAM_ERROR", message: "private customer detail", detail: { phone: "private" } }, 400);
  await assert.rejects(client.createPayment(order), (error: unknown) => error instanceof Error && 'code' in error && error.code === "PARAM_ERROR" && !error.message.includes("private"));
});

test("authenticated ciphertext with an invalid GCM tag cannot be decrypted", () => {
  const { client } = clientWith({});
  const event = JSON.parse(notification().raw);
  const bytes = Buffer.from(event.resource.ciphertext, "base64");
  bytes[bytes.length - 1] ^= 1;
  event.resource.ciphertext = bytes.toString("base64");
  const raw = JSON.stringify(event);
  assert.throws(() => client.verifyPaymentNotification(raw, signedHeaders(raw), order));
});

test("later configuration changes cannot reroute an existing merchant client", async () => {
  const calls: RequestInit[] = [];
  const options = { ...config, fetchImpl: async (_: string | URL | Request, init?: RequestInit) => { calls.push(init!); return response(null, 204); } };
  const client = createWeChatPayClient(options);
  options.merchantId = "9999999999";
  await client.closePayment(order.orderNo);
  assert.equal(JSON.parse(calls[0].body as string).mchid, config.merchantId);
});

test("does not let WeChat silently extend a nearly expired stock reservation", async () => {
  const { client, calls } = clientWith({ prepay_id: "test-expiry" });
  await assert.rejects(client.createPayment({ ...order, expiresAt: new Date(Date.now() + 30000).toISOString() }), /expiry/);
  await assert.rejects(client.createPayment({ ...order, expiresAt: new Date(Date.now() + 16 * 86400000).toISOString() }), /expiry/);
  assert.equal(calls.length, 0);
});

const expectedRefund = { orderNo: order.orderNo, refundNo: "REFUND0001", transactionId: "4200000001", totalFen: order.totalFen, refundFen: 5000 };
function refundNotification(changes: Record<string, unknown> = {}, eventType = "REFUND.SUCCESS") {
  return encryptedNotification({ mchid: config.merchantId, out_trade_no: order.orderNo,
    transaction_id: expectedRefund.transactionId, out_refund_no: expectedRefund.refundNo,
    refund_id: "5000000001", refund_status: "SUCCESS", success_time: "2026-09-08T01:00:00+08:00",
    amount: { total: order.totalFen, refund: 5000, payer_total: order.totalFen, payer_refund: 5000 },
    ...changes }, eventType, "refund");
}

test("refund notification verifies the original order, transaction and refund snapshot", () => {
  const { client } = clientWith({});
  const event = refundNotification();
  const result = client.verifyRefundNotification(event.raw, event.headers, expectedRefund);
  assert.equal(result.id, "event-1");
  assert.equal(result.refund.refund_id, "5000000001");
  assert.equal(result.refund.refund_status, "SUCCESS");
});

test("refund abnormal and closed notifications remain distinct from success", () => {
  const { client } = clientWith({});
  for (const status of ["ABNORMAL", "CLOSED"]) {
    const event = refundNotification({ refund_status: status, success_time: undefined }, `REFUND.${status}`);
    assert.equal(client.verifyRefundNotification(event.raw, event.headers, expectedRefund).refund.refund_status, status);
  }
});

test("refund notification rejects another merchant, order, transaction, refund or amount", () => {
  const { client } = clientWith({});
  for (const changes of [{ mchid: "OTHER" }, { out_trade_no: "OTHER" }, { transaction_id: "OTHER" },
    { out_refund_no: "OTHER" }, { refund_id: "" }, { refund_status: "ABNORMAL" },
    { amount: { total: 1, refund: 5000 } }, { amount: { total: order.totalFen, refund: 1 } }]) {
    const event = refundNotification(changes);
    assert.throws(() => client.verifyRefundNotification(event.raw, event.headers, expectedRefund), /mismatch/i);
  }
});

test("refund notification rejects tampering, stale signatures and invalid encryption", () => {
  const { client } = clientWith({});
  const event = refundNotification();
  assert.throws(() => client.verifyRefundNotification(`${event.raw} `, event.headers, expectedRefund), /signature/i);
  assert.throws(() => client.verifyRefundNotification(event.raw, signedHeaders(event.raw, { "Wechatpay-Timestamp": "1" }), expectedRefund), /timestamp/i);
  const envelope = JSON.parse(event.raw);
  const bytes = Buffer.from(envelope.resource.ciphertext, "base64");
  bytes[bytes.length - 1] ^= 1;
  envelope.resource.ciphertext = bytes.toString("base64");
  const invalid = JSON.stringify(envelope);
  assert.throws(() => client.verifyRefundNotification(invalid, signedHeaders(invalid), expectedRefund));
});

test("decodeNotification returns verified routing keys without needing a prior order lookup", () => {
  const { client } = clientWith({});
  const event = notification();
  const result = client.decodeNotification(event.raw, event.headers);
  assert.equal(result.id, "event-1");
  assert.equal(result.eventType, "TRANSACTION.SUCCESS");
  assert.equal(result.data.out_trade_no, order.orderNo);
});

test("decodeNotification rejects foreign merchant or payment app before exposing routing keys", () => {
  const { client } = clientWith({});
  for (const changes of [{ mchid: "OTHER" }, { appid: "OTHER" }]) {
    const event = notification(changes);
    assert.throws(() => client.decodeNotification(event.raw, event.headers), /mismatch/i);
  }
  const foreign = refundNotification({ mchid: "OTHER" });
  assert.throws(() => client.decodeNotification(foreign.raw, foreign.headers), /mismatch/i);
});

test("decodeNotification accepts only supported event and resource types with matching status", () => {
  const { client } = clientWith({});
  for (const status of ["SUCCESS", "ABNORMAL", "CLOSED"]) {
    const event = refundNotification({ refund_status: status }, `REFUND.${status}`);
    assert.equal(client.decodeNotification(event.raw, event.headers).eventType, `REFUND.${status}`);
  }
  for (const [eventType, originalType] of [["TRANSACTION.CLOSED", "transaction"], ["REFUND.PROCESSING", "refund"], ["TRANSACTION.SUCCESS", "refund"]]) {
    const event = encryptedNotification({ mchid: config.merchantId, appid: config.appId }, eventType, originalType);
    assert.throws(() => client.decodeNotification(event.raw, event.headers), /Unsupported/i);
  }
  const mismatch = refundNotification({ refund_status: "CLOSED" });
  assert.throws(() => client.decodeNotification(mismatch.raw, mismatch.headers), /mismatch/i);
});

test("decodeNotification authenticates before parsing and never leaks malformed content", () => {
  const { client } = clientWith({});
  const raw = '{"private-phone":"sensitive-personal-data"';
  assert.throws(() => client.decodeNotification(raw, signedHeaders("other")), /signature/i);
  assert.throws(() => client.decodeNotification(raw, signedHeaders(raw)), (error: unknown) =>
    error instanceof Error && !error.message.includes("sensitive-personal-data") && /Invalid notification/.test(error.message));
});
