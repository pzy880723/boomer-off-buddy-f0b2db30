/**
 * POS 微信/支付宝扫码支付的纯逻辑（无 IO），便于单测。
 * 明文付款码永远不会出现在数据库、日志或返回体中。
 */

export type PosScanProvider = "wechat" | "alipay";
export type PosPaymentMode = "merchant_scan" | "customer_scan";
export type PosPaymentStatus =
  | "pending"
  | "user_paying"
  | "paid"
  | "failed"
  | "closed"
  | "expired";

export const POS_PAYMENT_TERMINAL_STATUSES: PosPaymentStatus[] = [
  "paid",
  "failed",
  "closed",
  "expired",
];

export function isTerminalPosPaymentStatus(status: PosPaymentStatus) {
  return POS_PAYMENT_TERMINAL_STATUSES.includes(status);
}

export function isClosablePosPaymentStatus(status: PosPaymentStatus) {
  return status === "pending" || status === "user_paying";
}

/** 微信付款码：18 位数字，10~15 开头；支付宝付款码：16~24 位数字，25~30 开头。 */
export function detectAuthCodeProvider(authCode: string): PosScanProvider | null {
  const code = authCode.trim();
  if (!/^\d{16,24}$/.test(code)) return null;
  const prefix = Number(code.slice(0, 2));
  if (prefix >= 10 && prefix <= 15) return "wechat";
  if (prefix >= 25 && prefix <= 30) return "alipay";
  return null;
}

export function authCodeLast4(authCode: string) {
  return authCode.trim().slice(-4);
}

/** 商户订单号，微信要求 ≤32 位、仅字母数字与 -_ 。 */
export function buildOutTradeNo(now: Date, randomHex: string) {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `POS${stamp}${randomHex.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12).toUpperCase()}`;
}

export function toMinorUnits(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("支付金额不合法");
  return Math.round(amount * 100);
}

export function fromMinorUnits(minor: number) {
  return Number((minor / 100).toFixed(2));
}

export function mapWechatTradeState(state: string | null | undefined): PosPaymentStatus {
  switch ((state || "").toUpperCase()) {
    case "SUCCESS":
      return "paid";
    case "USERPAYING":
      return "user_paying";
    case "NOTPAY":
      return "pending";
    case "CLOSED":
    case "REVOKED":
      return "closed";
    case "PAYERROR":
      return "failed";
    default:
      return "pending";
  }
}

/** 支付宝当面付：10000 成功；10003 等待用户付款；其余按失败处理。 */
export function mapAlipayResponse(input: {
  code: string | null | undefined;
  subCode?: string | null;
}): PosPaymentStatus {
  const code = (input.code || "").trim();
  if (code === "10000") return "paid";
  if (code === "10003") return "user_paying";
  if (code === "20000") return "pending";

  return "failed";
}

/** 只有从 pending/user_paying 才能推进；已支付不允许被后续回调改写。 */
export function canTransitionPosPayment(from: PosPaymentStatus, to: PosPaymentStatus) {
  if (from === to) return false;
  if (from === "paid") return false;
  if (isTerminalPosPaymentStatus(from)) return false;
  return true;
}

export function isPosPaymentExpired(expiresAt: string | null, now = new Date()) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= now.getTime();
}

/** 回调金额必须与本地记录一致（按分比较），否则拒绝。 */
export function assertCallbackAmountMatches(expected: number, actualMinor: number) {
  if (toMinorUnits(expected) !== Math.round(actualMinor)) {
    throw new Error("回调金额与订单金额不一致");
  }
}
