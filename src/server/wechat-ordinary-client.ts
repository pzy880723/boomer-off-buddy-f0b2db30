import { KeyObject, createPrivateKey, createPublicKey, createDecipheriv, randomBytes, sign, verify } from "node:crypto";

export interface WeChatPayConfig {
  appId: string; merchantId: string; certificateSerial: string;
  privateKey: string | Buffer | KeyObject; wechatPublicKey: string | Buffer | KeyObject;
  wechatPublicKeyId: string; apiV3Key: string | Buffer;
  notifyUrl: string; refundNotifyUrl: string; fetchImpl?: typeof fetch;
}
export interface ExpectedPayment { orderNo: string; totalFen: number }
export interface CreatePaymentInput extends ExpectedPayment { openid: string; description: string; expiresAt?: string }
export interface RefundInput extends ExpectedPayment { refundNo: string; refundFen: number; reason?: string }
export interface ExpectedRefund extends RefundInput { transactionId: string }
export interface WeChatTransaction extends Record<string, unknown> {
  mchid: string; appid: string; out_trade_no: string; transaction_id: string;
  trade_state: "SUCCESS"; amount: { total: number; currency: "CNY" };
}
export interface WeChatRefund extends Record<string, unknown> {
  mchid: string; out_trade_no: string; transaction_id: string; out_refund_no: string;
  refund_id: string; refund_status: "SUCCESS" | "ABNORMAL" | "CLOSED";
  amount: { total: number; refund: number; currency?: string };
}
export type DecodedNotification =
  | { id: string; eventType: "TRANSACTION.SUCCESS"; data: WeChatTransaction }
  | { id: string; eventType: "REFUND.SUCCESS" | "REFUND.ABNORMAL" | "REFUND.CLOSED"; data: WeChatRefund };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid notification or response");
  return value as Record<string, unknown>;
}
function parseRecord(raw: string): Record<string, unknown> {
  try { return record(JSON.parse(raw)); }
  catch { throw new Error("Invalid notification or response"); }
}

function text(value: unknown, name: string, pattern = /^[^\r\n]+$/) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid amount: use positive integer fen");
  return value;
}

function orderNumber(value: unknown) {
  return text(value, "order number", /^[A-Za-z0-9_|*-]{6,32}$/);
}

function httpsUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid callback URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Callback must use https without credentials or fragment");
  return url.toString();
}

function unknownResult() {
  return Object.assign(new Error("Payment result unknown; query the original order before retrying"), { code: "payment_result_unknown" });
}

// Service-side protocol client only. Callers must authorize the order and resolve
// its persisted payment channel before using this client. No ERP ledger writes.
export function createWeChatPayClient({
  appId, merchantId, certificateSerial, privateKey, wechatPublicKey,
  wechatPublicKeyId, apiV3Key, notifyUrl, refundNotifyUrl, fetchImpl = fetch,
}: WeChatPayConfig) {
  text(appId, "AppID", /^[A-Za-z0-9_-]+$/);
  text(merchantId, "merchant ID", /^\d+$/);
  text(certificateSerial, "certificate serial", /^[A-Fa-f0-9]+$/);
  text(wechatPublicKeyId, "public key ID", /^PUB_KEY_ID_[A-Za-z0-9]+$/);
  const merchantKey = privateKey instanceof KeyObject && privateKey.type === "private" ? privateKey : createPrivateKey(privateKey as string | Buffer);
  const platformKey = wechatPublicKey instanceof KeyObject && wechatPublicKey.type === "public" ? wechatPublicKey : createPublicKey(wechatPublicKey as string | Buffer);
  for (const key of [merchantKey, platformKey]) {
    if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 2048) throw new Error("Expected RSA2048 key");
  }
  const aesKey = Buffer.from(apiV3Key);
  if (aesKey.length !== 32) throw new Error("APIv3 key must be 32 bytes");
  const paymentCallback = httpsUrl(notifyUrl);
  const refundCallback = httpsUrl(refundNotifyUrl);
  const signature = (message: string) => sign("RSA-SHA256", Buffer.from(message), merchantKey).toString("base64");

  function verifyMessage(rawBody: string, suppliedHeaders: HeadersInit) {
    const headers = new Headers(suppliedHeaders);
    const timestamp = headers.get("Wechatpay-Timestamp");
    const nonce = headers.get("Wechatpay-Nonce");
    const signed = headers.get("Wechatpay-Signature");
    if (!/^\d+$/.test(timestamp || "") || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new Error("Invalid signature timestamp");
    if (headers.get("Wechatpay-Serial") !== wechatPublicKeyId) throw new Error("Unknown WeChat verification key");
    const signatureType = headers.get("Wechatpay-Signature-Type");
    if (signatureType && signatureType !== "WECHATPAY2-SHA256-RSA2048") throw new Error("Invalid signature type");
    if (!nonce || !signed || !verify("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${rawBody}\n`), platformKey, Buffer.from(signed, "base64"))) {
      throw new Error("Invalid WeChat signature");
    }
  }

  async function request(method: string, path: string, payload?: unknown, requireClosed = false): Promise<Record<string, unknown> | null> {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${merchantId}",nonce_str="${nonce}",signature="${signature(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`)}",timestamp="${timestamp}",serial_no="${certificateSerial}"`;
    let response;
    let raw;
    try {
      response = await fetchImpl(`https://api.mch.weixin.qq.com${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { Authorization: authorization, Accept: "application/json", "Content-Type": "application/json", "Wechatpay-Serial": wechatPublicKeyId },
        ...(payload === undefined ? {} : { body }),
      });
      raw = await response.text();
    } catch (_) {
      // Timeout does not prove WeChat rejected the request. Do not auto-retry.
      throw unknownResult();
    }
    verifyMessage(raw, response.headers);
    const data = raw ? parseRecord(raw) : null;
    if (!response.ok) {
      // Do not expose provider message/detail fields (may contain personal data).
      const code = typeof data?.code === "string" && /^[A-Z0-9_]+$/.test(data.code) ? data.code : "WECHAT_API_ERROR";
      throw Object.assign(new Error(`WeChat request rejected (${code})`), { code, status: response.status });
    }
    if (requireClosed && (response.status !== 204 || raw !== '')) throw new Error('Close requires signed empty HTTP 204');
    return data;
  }


  function decodeNotification(rawBody: string, headers: HeadersInit): DecodedNotification {
    verifyMessage(rawBody, headers);
    const event = parseRecord(rawBody);
    const resource = record(event.resource);
    const id = text(event.id, "notification ID");
    const eventType = event.event_type;
    const isPayment = eventType === "TRANSACTION.SUCCESS";
    const isRefund = eventType === "REFUND.SUCCESS" || eventType === "REFUND.ABNORMAL" || eventType === "REFUND.CLOSED";
    if ((!isPayment && !isRefund) || resource.original_type !== (isPayment ? "transaction" : "refund")
      || resource.algorithm !== "AEAD_AES_256_GCM") throw new Error("Unsupported encrypted notification");
    let data: Record<string, unknown>;
    try {
      const ciphertext = Buffer.from(text(resource.ciphertext, "ciphertext"), "base64");
      const nonce = text(resource.nonce, "notification nonce");
      if (ciphertext.length <= 16 || Buffer.byteLength(nonce) !== 12) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(nonce));
      decipher.setAAD(Buffer.from(resource.associated_data === undefined ? "" : text(resource.associated_data, "associated data", /^[^\r\n]*$/)));
      decipher.setAuthTag(ciphertext.subarray(-16));
      data = parseRecord(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString("utf8"));
    } catch { throw new Error("Invalid encrypted notification"); }
    if (data.mchid !== merchantId) throw new Error("Notification merchant mismatch");
    if (isPayment && (data.appid !== appId || data.trade_state !== "SUCCESS")) throw new Error("Payment notification identity mismatch");
    if (isRefund && eventType !== "REFUND." + data.refund_status) throw new Error("Refund notification status mismatch");
    text(data.out_trade_no, "notification order number");
    text(data.transaction_id, "notification transaction ID");
    const sums = record(data.amount);
    amount(sums.total);
    if (isPayment) {
      if (sums.currency !== "CNY") throw new Error("Payment notification currency mismatch");
      return { id, eventType: "TRANSACTION.SUCCESS", data: data as WeChatTransaction };
    }
    text(data.out_refund_no, "notification refund number");
    if (typeof data.refund_id !== "string" || !data.refund_id) throw new Error("Refund notification ID mismatch");
    amount(sums.refund);
    if ((sums.refund as number) > (sums.total as number) || (sums.currency !== undefined && sums.currency !== "CNY"))
      throw new Error("Refund notification amount mismatch");
    return { id, eventType: eventType as "REFUND.SUCCESS" | "REFUND.ABNORMAL" | "REFUND.CLOSED", data: data as WeChatRefund };
  }

  return {
    decodeNotification,
    async createPayment({ orderNo, totalFen, openid, description, expiresAt }: CreatePaymentInput) {
      const payload: Record<string, unknown> = {
        appid: appId, mchid: merchantId, out_trade_no: orderNumber(orderNo),
        description: text(description, "description"), notify_url: paymentCallback,
        amount: { total: amount(totalFen), currency: "CNY" },
        payer: { openid: text(openid, "OpenID") },
      };
      if (description.length > 127) throw new Error("Invalid description length");
      if (expiresAt !== undefined) {
        const remaining = Date.parse(expiresAt) - Date.now();
        if (!Number.isFinite(remaining) || remaining < 60000 || remaining > 15 * 86400000) throw new Error("Invalid payment expiry");
        payload.time_expire = new Date(expiresAt).toISOString();
      }
      const data = await request("POST", "/v3/pay/transactions/jsapi", payload);
      const prepayId = text(data?.prepay_id, "prepay ID", /^[A-Za-z0-9_-]+$/);
      const timeStamp = String(Math.floor(Date.now() / 1000));
      const nonceStr = randomBytes(16).toString("hex");
      const packageValue = `prepay_id=${prepayId}`;
      return {
        prepay_id: prepayId,
        payment_payload: { timeStamp, nonceStr, package: packageValue, signType: "RSA", paySign: signature(`${appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`) },
      };
    },
    queryPayment(orderNo: string) {
      return request("GET", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNumber(orderNo))}?mchid=${merchantId}`);
    },
    closePayment(orderNo: string) {
      return request("POST", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNumber(orderNo))}/close`, { mchid: merchantId }, true);
    },
    async refund({ orderNo, refundNo, totalFen, refundFen, reason }: RefundInput) {
      if (amount(refundFen) > amount(totalFen)) throw new Error("Refund amount exceeds order amount");
      return request("POST", "/v3/refund/domestic/refunds", {
        out_trade_no: orderNumber(orderNo), out_refund_no: orderNumber(refundNo),
        amount: { refund: refundFen, total: totalFen, currency: "CNY" }, notify_url: refundCallback,
        ...(reason ? { reason: text(reason, "refund reason") } : {}),
      });
    },
    queryRefund(refundNo: string) {
      return request("GET", `/v3/refund/domestic/refunds/${encodeURIComponent(orderNumber(refundNo))}`);
    },
    verifyPaymentNotification(rawBody: string, headers: HeadersInit, expectedOrder: ExpectedPayment) {
      const decoded = decodeNotification(rawBody, headers);
      if (decoded.eventType !== "TRANSACTION.SUCCESS") throw new Error("Unsupported payment notification");
      const transaction = decoded.data;
      if (transaction.mchid !== merchantId || transaction.appid !== appId
        || transaction.out_trade_no !== expectedOrder.orderNo || transaction.trade_state !== "SUCCESS"
        || !transaction.transaction_id || transaction.amount?.currency !== "CNY"
        || transaction.amount?.total !== amount(expectedOrder.totalFen)) throw new Error("Payment notification order mismatch");
      // The ERP must still atomically deduplicate event/transaction IDs and post
      // inventory/order/ledger changes before acknowledging a notification.
      return { id: decoded.id, transaction };
    },
    verifyRefundNotification(rawBody: string, headers: HeadersInit, expectedRefund: ExpectedRefund) {
      const decoded = decodeNotification(rawBody, headers);
      if (decoded.eventType === "TRANSACTION.SUCCESS") throw new Error("Unsupported refund notification");
      const refund = decoded.data;
      if (refund.mchid !== merchantId || refund.out_trade_no !== expectedRefund.orderNo
        || refund.out_refund_no !== expectedRefund.refundNo
        || refund.transaction_id !== text(expectedRefund.transactionId, "original transaction ID")
        || !refund.refund_id || decoded.eventType !== `REFUND.${refund.refund_status}`
        || refund.amount?.total !== amount(expectedRefund.totalFen)
        || refund.amount?.refund !== amount(expectedRefund.refundFen)
        || expectedRefund.refundFen > expectedRefund.totalFen) throw new Error("Refund notification order mismatch");
      // Return the actual status; abnormal/closed must not be posted as refunded.
      // Durable event deduplication and refund ledger updates belong to the ERP.
      return { id: decoded.id, refund };
    },
  };
}
