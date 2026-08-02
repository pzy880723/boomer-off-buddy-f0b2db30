/**
 * 微信支付 / 支付宝当面付的服务端接入层。
 * 所有密钥只从服务端 secrets 读取，绝不返回 APP、不写数据库、不打日志。
 * 未配置时返回 configured=false，路由照常上线并回 503 payment_not_configured。
 */
import {
  fromMinorUnits,
  mapAlipayResponse,
  mapWechatTradeState,
  toMinorUnits,
  type PosPaymentStatus,
  type PosScanProvider,
} from "@/lib/pos/pos-scan-payment";

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64(buffer: ArrayBuffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256Hex(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function pemBody(pem: string) {
  return pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
}

async function importPrivateKey(pem: string) {
  return crypto.subtle.importKey(
    "pkcs8",
    fromBase64(pemBody(pem)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function importPublicKey(pem: string) {
  return crypto.subtle.importKey(
    "spki",
    fromBase64(pemBody(pem)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

async function rsaSign(pem: string, payload: string) {
  const key = await importPrivateKey(pem);
  return base64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(payload)));
}

async function rsaVerify(pem: string, payload: string, signature: string) {
  try {
    const key = await importPublicKey(pem);
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      fromBase64(signature),
      encoder.encode(payload),
    );
  } catch {
    return false;
  }
}

export type WechatConfig = {
  configured: true;
  mchId: string;
  serialNo: string;
  privateKey: string;
  apiV3Key: string;
  appId: string;
  platformPublicKey: string;
  notifyUrl: string;
};

export type AlipayConfig = {
  configured: true;
  appId: string;
  privateKey: string;
  alipayPublicKey: string;
  gatewayUrl: string;
  notifyUrl: string;
};

export function wechatConfig(): WechatConfig | { configured: false; missing: string[] } {
  const values = {
    mchId: process.env["WECHAT_PAY_MCHID"],
    serialNo: process.env["WECHAT_PAY_SERIAL_NO"],
    privateKey: process.env["WECHAT_PAY_PRIVATE_KEY"],
    apiV3Key: process.env["WECHAT_PAY_APIV3_KEY"],
    appId: process.env["WECHAT_PAY_APPID"],
    platformPublicKey: process.env["WECHAT_PAY_PLATFORM_PUBLIC_KEY"],
    notifyUrl: process.env["WECHAT_PAY_NOTIFY_URL"],
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) return { configured: false, missing };
  return { configured: true, ...(values as Record<string, string>) } as WechatConfig;
}

export function alipayConfig(): AlipayConfig | { configured: false; missing: string[] } {
  const values = {
    appId: process.env["ALIPAY_APP_ID"],
    privateKey: process.env["ALIPAY_PRIVATE_KEY"],
    alipayPublicKey: process.env["ALIPAY_PUBLIC_KEY"],
    gatewayUrl: process.env["ALIPAY_GATEWAY_URL"] || "https://openapi.alipay.com/gateway.do",
    notifyUrl: process.env["ALIPAY_NOTIFY_URL"],
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) return { configured: false, missing };
  return { configured: true, ...(values as Record<string, string>) } as AlipayConfig;
}

export function providerConfigured(provider: PosScanProvider) {
  const config = provider === "wechat" ? wechatConfig() : alipayConfig();
  return config.configured ? { ok: true as const, config } : { ok: false as const, missing: config.missing };
}

async function wechatRequest(
  config: WechatConfig,
  method: "POST" | "GET",
  path: string,
  body: unknown,
) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replace(/-/g, "").toUpperCase();
  const payload = body ? JSON.stringify(body) : "";
  const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${payload}\n`;
  const signature = await rsaSign(config.privateKey, message);
  const authorization =
    `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",` +
    `signature="${signature}",timestamp="${timestamp}",serial_no="${config.serialNo}"`;
  const response = await fetch(`https://api.mch.weixin.qq.com${path}`, {
    method,
    headers: {
      Authorization: authorization,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "boomer-off-erp-pos/1.0",
    },
    ...(payload ? { body: payload } : {}),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { code: "INVALID_RESPONSE" };
  }
  return { status: response.status, json };
}

export type ProviderChargeResult = {
  status: PosPaymentStatus;
  providerTransactionId: string | null;
  qrContent: string | null;
  message: string | null;
  errorCode: string | null;
  raw: Record<string, unknown>;
};

/** 微信付款码支付（服务商模式主扫）。 */
export async function wechatMicropay(input: {
  config: WechatConfig;
  subMchId: string;
  subAppId?: string | null;
  outTradeNo: string;
  amount: number;
  authCode: string;
  description: string;
}): Promise<ProviderChargeResult> {
  const { status, json } = await wechatRequest(
    input.config,
    "POST",
    "/v3/pay/partner/transactions/codepay",
    {
      sp_appid: input.config.appId,
      sp_mchid: input.config.mchId,
      sub_mchid: input.subMchId,
      ...(input.subAppId ? { sub_appid: input.subAppId } : {}),
      description: input.description,
      out_trade_no: input.outTradeNo,
      payer: { auth_code: input.authCode },
      amount: { total: toMinorUnits(input.amount), currency: "CNY" },
    },
  );
  const tradeState = String(json["trade_state"] ?? "");
  if (status >= 400 && !tradeState) {
    const code = String(json["code"] ?? "PROVIDER_ERROR");
    return {
      status: code === "USERPAYING" ? "user_paying" : "failed",
      providerTransactionId: null,
      qrContent: null,
      message: String(json["message"] ?? "微信支付失败"),
      errorCode: code,
      raw: json,
    };
  }
  return {
    status: mapWechatTradeState(tradeState),
    providerTransactionId: (json["transaction_id"] as string) ?? null,
    qrContent: null,
    message: (json["trade_state_desc"] as string) ?? null,
    errorCode: null,
    raw: json,
  };
}

/** 微信 Native 下单（客扫，订单专属动态码）。 */
export async function wechatNative(input: {
  config: WechatConfig;
  subMchId: string;
  outTradeNo: string;
  amount: number;
  description: string;
  expiresAt: Date;
}): Promise<ProviderChargeResult> {
  const { status, json } = await wechatRequest(
    input.config,
    "POST",
    "/v3/pay/partner/transactions/native",
    {
      sp_appid: input.config.appId,
      sp_mchid: input.config.mchId,
      sub_mchid: input.subMchId,
      description: input.description,
      out_trade_no: input.outTradeNo,
      time_expire: input.expiresAt.toISOString().replace(/\.\d+Z$/, "+00:00"),
      notify_url: input.config.notifyUrl,
      amount: { total: toMinorUnits(input.amount), currency: "CNY" },
    },
  );
  if (status >= 400 || !json["code_url"]) {
    return {
      status: "failed",
      providerTransactionId: null,
      qrContent: null,
      message: String(json["message"] ?? "微信下单失败"),
      errorCode: String(json["code"] ?? "PROVIDER_ERROR"),
      raw: json,
    };
  }
  return {
    status: "pending",
    providerTransactionId: null,
    qrContent: String(json["code_url"]),
    message: null,
    errorCode: null,
    raw: json,
  };
}

async function alipayRequest(
  config: AlipayConfig,
  method: string,
  bizContent: Record<string, unknown>,
  notifyUrl?: string,
) {
  const params: Record<string, string> = {
    app_id: config.appId,
    method,
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19),
    version: "1.0",
    biz_content: JSON.stringify(bizContent),
    ...(notifyUrl ? { notify_url: notifyUrl } : {}),
  };
  const signSource = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  params["sign"] = await rsaSign(config.privateKey, signSource);
  const response = await fetch(config.gatewayUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  const responseKey = `${method.replace(/\./g, "_")}_response`;
  return (json[responseKey] as Record<string, unknown>) ?? { code: "40004", msg: "无效响应" };
}

/** 支付宝当面付付款码支付（主扫）。 */
export async function alipayMicropay(input: {
  config: AlipayConfig;
  outTradeNo: string;
  amount: number;
  authCode: string;
  subject: string;
  sellerId?: string | null;
}): Promise<ProviderChargeResult> {
  const body = await alipayRequest(input.config, "alipay.trade.pay", {
    out_trade_no: input.outTradeNo,
    scene: "bar_code",
    auth_code: input.authCode,
    subject: input.subject,
    total_amount: input.amount.toFixed(2),
    ...(input.sellerId ? { seller_id: input.sellerId } : {}),
  });
  const status = mapAlipayResponse({
    code: body["code"] as string,
    subCode: body["sub_code"] as string,
  });
  return {
    status,
    providerTransactionId: (body["trade_no"] as string) ?? null,
    qrContent: null,
    message: (body["sub_msg"] as string) ?? (body["msg"] as string) ?? null,
    errorCode: status === "failed" ? ((body["sub_code"] as string) ?? "ALIPAY_ERROR") : null,
    raw: body,
  };
}

/** 支付宝当面付预下单（客扫，订单专属动态码）。 */
export async function alipayPrecreate(input: {
  config: AlipayConfig;
  outTradeNo: string;
  amount: number;
  subject: string;
  timeoutMinutes: number;
  sellerId?: string | null;
}): Promise<ProviderChargeResult> {
  const body = await alipayRequest(
    input.config,
    "alipay.trade.precreate",
    {
      out_trade_no: input.outTradeNo,
      subject: input.subject,
      total_amount: input.amount.toFixed(2),
      timeout_express: `${input.timeoutMinutes}m`,
      ...(input.sellerId ? { seller_id: input.sellerId } : {}),
    },
    input.config.notifyUrl,
  );
  if (body["code"] !== "10000" || !body["qr_code"]) {
    return {
      status: "failed",
      providerTransactionId: null,
      qrContent: null,
      message: (body["sub_msg"] as string) ?? (body["msg"] as string) ?? "支付宝下单失败",
      errorCode: (body["sub_code"] as string) ?? "ALIPAY_ERROR",
      raw: body,
    };
  }
  return {
    status: "pending",
    providerTransactionId: null,
    qrContent: String(body["qr_code"]),
    message: null,
    errorCode: null,
    raw: body,
  };
}

/** 主动查单，用于 APP 轮询和主扫 user_paying 状态收敛。 */
export async function wechatQuery(input: {
  config: WechatConfig;
  subMchId: string;
  outTradeNo: string;
}): Promise<ProviderChargeResult> {
  const path =
    `/v3/pay/partner/transactions/out-trade-no/${encodeURIComponent(input.outTradeNo)}` +
    `?sp_mchid=${input.config.mchId}&sub_mchid=${input.subMchId}`;
  const { json } = await wechatRequest(input.config, "GET", path, null);
  return {
    status: mapWechatTradeState(json["trade_state"] as string),
    providerTransactionId: (json["transaction_id"] as string) ?? null,
    qrContent: null,
    message: (json["trade_state_desc"] as string) ?? null,
    errorCode: null,
    raw: json,
  };
}

export async function alipayQuery(input: {
  config: AlipayConfig;
  outTradeNo: string;
}): Promise<ProviderChargeResult> {
  const body = await alipayRequest(input.config, "alipay.trade.query", {
    out_trade_no: input.outTradeNo,
  });
  const tradeStatus = String(body["trade_status"] ?? "");
  const status: PosPaymentStatus =
    tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED"
      ? "paid"
      : tradeStatus === "WAIT_BUYER_PAY"
        ? "user_paying"
        : tradeStatus === "TRADE_CLOSED"
          ? "closed"
          : "pending";
  return {
    status,
    providerTransactionId: (body["trade_no"] as string) ?? null,
    qrContent: null,
    message: (body["msg"] as string) ?? null,
    errorCode: null,
    raw: body,
  };
}

/** 微信支付回调验签 + APIv3 解密。 */
export async function verifyWechatCallback(input: {
  config: WechatConfig;
  headers: Headers;
  rawBody: string;
}): Promise<{ ok: false } | { ok: true; resource: Record<string, unknown> }> {
  const timestamp = input.headers.get("Wechatpay-Timestamp") ?? "";
  const nonce = input.headers.get("Wechatpay-Nonce") ?? "";
  const signature = input.headers.get("Wechatpay-Signature") ?? "";
  if (!timestamp || !nonce || !signature) return { ok: false };
  const message = `${timestamp}\n${nonce}\n${input.rawBody}\n`;
  if (!(await rsaVerify(input.config.platformPublicKey, message, signature))) return { ok: false };
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(input.rawBody) as Record<string, unknown>;
  } catch {
    return { ok: false };
  }
  const resource = body["resource"] as
    | { ciphertext?: string; nonce?: string; associated_data?: string }
    | undefined;
  if (!resource?.ciphertext || !resource.nonce) return { ok: false };
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(input.config.apiV3Key),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: encoder.encode(resource.nonce),
        additionalData: encoder.encode(resource.associated_data ?? ""),
      },
      key,
      fromBase64(resource.ciphertext),
    );
    return { ok: true, resource: JSON.parse(new TextDecoder().decode(plain)) };
  } catch {
    return { ok: false };
  }
}

/** 支付宝异步通知验签（表单参数排序 + RSA2）。 */
export async function verifyAlipayCallback(input: {
  config: AlipayConfig;
  params: Record<string, string>;
}) {
  const signature = input.params["sign"];
  if (!signature) return false;
  const source = Object.keys(input.params)
    .filter((key) => key !== "sign" && key !== "sign_type" && input.params[key] !== "")
    .sort()
    .map((key) => `${key}=${input.params[key]}`)
    .join("&");
  return rsaVerify(input.config.alipayPublicKey, source, signature);
}

export { fromMinorUnits, toMinorUnits };
