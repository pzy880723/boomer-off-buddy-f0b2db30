// 腾讯云短信 SendSms —— 纯 fetch + TC3-HMAC-SHA256 签名，无 SDK，Worker 友好。
// 文档: https://cloud.tencent.com/document/product/382/55981
import { createHash, createHmac } from "node:crypto";

const ENDPOINT = "sms.tencentcloudapi.com";
const SERVICE = "sms";
const VERSION = "2021-01-11";
const ACTION = "SendSms";
const REGION = "ap-guangzhou";

function sha256Hex(s: string) {
  return createHash("sha256").update(s).digest("hex");
}
function hmac(key: Buffer | string, s: string) {
  return createHmac("sha256", key).update(s).digest();
}

export type SendOtpResult = {
  ok: boolean;
  serial?: string;
  code?: string;
  message?: string;
  raw?: unknown;
};

export async function sendOtpSms(
  phoneE164: string,
  code: string,
  ttlMinutes = 5,
): Promise<SendOtpResult> {
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  const sdkAppId = process.env.TENCENT_SMS_SDK_APP_ID;
  const signName = process.env.TENCENT_SMS_SIGN_NAME;
  const templateId = process.env.TENCENT_SMS_TEMPLATE_ID;
  if (!secretId || !secretKey || !sdkAppId || !signName || !templateId) {
    return { ok: false, code: "sms_not_configured", message: "短信服务未配置" };
  }

  const payload = {
    PhoneNumberSet: [phoneE164],
    SmsSdkAppId: sdkAppId,
    SignName: signName,
    TemplateId: templateId,
    TemplateParamSet: [code, String(ttlMinutes)],
  };
  const body = JSON.stringify(payload);

  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // YYYY-MM-DD UTC

  // Canonical request
  const httpMethod = "POST";
  const canonicalUri = "/";
  const canonicalQueryString = "";
  const canonicalHeaders =
    `content-type:application/json; charset=utf-8\n` +
    `host:${ENDPOINT}\n` +
    `x-tc-action:${ACTION.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const hashedRequestPayload = sha256Hex(body);
  const canonicalRequest = [
    httpMethod,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    hashedRequestPayload,
  ].join("\n");

  // String to sign
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const hashedCanonicalRequest = sha256Hex(canonicalRequest);
  const stringToSign = ["TC3-HMAC-SHA256", timestamp, credentialScope, hashedCanonicalRequest].join(
    "\n",
  );

  // Signing
  const secretDate = hmac("TC3" + secretKey, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = createHmac("sha256", secretSigning)
    .update(stringToSign)
    .digest("hex");

  const authorization =
    `TC3-HMAC-SHA256 ` +
    `Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  const resp = await fetch(`https://${ENDPOINT}/`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json; charset=utf-8",
      Host: ENDPOINT,
      "X-TC-Action": ACTION,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": VERSION,
      "X-TC-Region": REGION,
    },
    body,
  });

  const json = (await resp.json().catch(() => ({}))) as {
    Response?: {
      Error?: { Code: string; Message: string };
      SendStatusSet?: Array<{ Code: string; Message: string; SerialNo: string }>;
      RequestId?: string;
    };
  };

  const r = json.Response;
  if (r?.Error) {
    return { ok: false, code: r.Error.Code, message: r.Error.Message, raw: json };
  }
  const status = r?.SendStatusSet?.[0];
  if (status?.Code !== "Ok") {
    return {
      ok: false,
      code: status?.Code ?? "unknown",
      message: status?.Message ?? "短信发送失败",
      raw: json,
    };
  }
  return { ok: true, serial: status.SerialNo, raw: json };
}
