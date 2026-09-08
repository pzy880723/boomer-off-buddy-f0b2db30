import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DecodedNotification } from "./wechat-ordinary-client";

const Amount = z.object({
  total: z.number().int().positive(),
  refund: z.number().int().positive().optional(),
  currency: z.literal("CNY"),
});

export const OrdinaryGatewayEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("payment.succeeded"),
    event_id: z.string().trim().min(6).max(200),
    merchant_id: z.string().regex(/^\d{6,20}$/),
    app_id: z.string().regex(/^wx[a-zA-Z0-9]{16}$/),
    out_trade_no: z.string().regex(/^[A-Za-z0-9_|*-]{6,32}$/),
    transaction_id: z.string().trim().min(6).max(64),
    amount: Amount,
    payer: z.object({ openid: z.string().trim().min(1).max(200) }),
    success_time: z.string().trim().min(10).max(64),
  }),
  z.object({
    type: z.literal("refund.updated"),
    event_id: z.string().trim().min(6).max(200),
    merchant_id: z.string().regex(/^\d{6,20}$/),
    app_id: z.string().regex(/^wx[a-zA-Z0-9]{16}$/),
    out_trade_no: z.string().regex(/^[A-Za-z0-9_|*-]{6,32}$/),
    out_refund_no: z.string().regex(/^[A-Za-z0-9_|*-]{6,64}$/),
    transaction_id: z.string().trim().min(6).max(64),
    refund_id: z.string().trim().min(6).max(64),
    refund_status: z.enum(["SUCCESS", "ABNORMAL", "CLOSED"]),
    amount: Amount.extend({ refund: z.number().int().positive() }),
    success_time: z.string().trim().min(10).max(64).optional(),
  }),
]);
export type OrdinaryGatewayEvent = z.infer<typeof OrdinaryGatewayEvent>;

/** 内部可信事件签名：HMAC-SHA256(`${timestamp}.${rawBody}`)，5 分钟窗口，定长比较。 */
export function verifyGatewayEventSignature(input: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  now?: number;
}): boolean {
  const { rawBody, timestamp, signature, secret } = input;
  if (!timestamp || !signature || !/^\d{10,13}$/.test(timestamp)) return false;
  const seconds = timestamp.length > 10 ? Number(timestamp) / 1000 : Number(timestamp);
  const now = (input.now ?? Date.now()) / 1000;
  if (!Number.isFinite(seconds) || Math.abs(now - seconds) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const supplied = signature
    .trim()
    .replace(/^sha256=/i, "")
    .toLowerCase();
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

/**
 * 可信内部事件 → 与微信原始回调完全一致的结构，交给既有 applyOrdinaryNotification
 * 复核持久化快照（商户号、AppID、订单号、币种、金额、openid）并走幂等入账 RPC。
 */
export function toDecodedNotification(
  event: OrdinaryGatewayEvent,
  expected: { merchantId: string; appId: string },
): DecodedNotification {
  if (event.merchant_id !== expected.merchantId || event.app_id !== expected.appId)
    throw new Error("Gateway event merchant mismatch");
  if (event.type === "payment.succeeded") {
    return {
      id: `gw:${event.event_id}`,
      eventType: "TRANSACTION.SUCCESS",
      data: {
        mchid: event.merchant_id,
        appid: event.app_id,
        out_trade_no: event.out_trade_no,
        transaction_id: event.transaction_id,
        trade_state: "SUCCESS",
        amount: { total: event.amount.total, currency: "CNY" },
        payer: { openid: event.payer.openid },
        success_time: event.success_time,
      },
    };
  }
  const eventType = (
    { SUCCESS: "REFUND.SUCCESS", ABNORMAL: "REFUND.ABNORMAL", CLOSED: "REFUND.CLOSED" } as const
  )[event.refund_status];
  return {
    id: `gw:${event.event_id}`,
    eventType,
    data: {
      mchid: event.merchant_id,
      out_trade_no: event.out_trade_no,
      transaction_id: event.transaction_id,
      out_refund_no: event.out_refund_no,
      refund_id: event.refund_id,
      refund_status: event.refund_status,
      amount: { total: event.amount.total, refund: event.amount.refund, currency: "CNY" },
      ...(event.success_time ? { success_time: event.success_time } : {}),
    },
  };
}
