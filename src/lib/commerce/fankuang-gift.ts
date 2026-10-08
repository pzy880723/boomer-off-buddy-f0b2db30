/**
 * 翻筐乐分筐 / 赠礼盲盒合同（纯函数，服务端路由与测试共用）。
 * 权威逻辑在数据库 RPC（候选迁移 0046）；这里只做请求校验与错误码映射。
 */
import { z } from "zod";

export const FANKUANG_BASKET_SIZE = 100;
export const FANKUANG_GIFT_PROBABILITY = 0.01;

const ClientOpId = z.string().trim().min(8).max(80);

export const SessionStartRequest = z.object({ client_op_id: ClientOpId });
export const FlipRequest = z.object({
  session_id: z.string().uuid(),
  listing_id: z.string().uuid(),
  client_op_id: ClientOpId,
});

/** 下单可选赠礼字段：省略 = 不领赠礼；两者同时给出时数量必须一致。 */
export const GiftOrderFields = z
  .object({
    gift_entitlement_ids: z.array(z.string().uuid()).min(1).max(999).optional(),
    gift_count: z.number().int().min(0).max(999).optional(),
  })
  .refine((v) => !v.gift_entitlement_ids || new Set(v.gift_entitlement_ids).size === v.gift_entitlement_ids.length, {
    message: "gift_entitlement_ids must be unique",
  })
  .refine((v) => !v.gift_entitlement_ids || v.gift_count === undefined || v.gift_count === v.gift_entitlement_ids.length, {
    message: "gift_count must equal gift_entitlement_ids length",
  });

export function requestedGiftCount(v: { gift_entitlement_ids?: string[]; gift_count?: number }): number {
  return v.gift_count ?? v.gift_entitlement_ids?.length ?? 0;
}

/** 仅供客户端预估；权威付费件数由数据库按成交单价 unit_price > 0 的非赠礼行计算。 */
export function paidItemQuantity(body: {
  items?: Array<{ quantity: number; listing_id?: string }>;
  listing_ids?: string[];
}): number {
  if (body.items) return body.items.reduce((sum, i) => sum + i.quantity, 0);
  return body.listing_ids?.length ?? 0;
}

export type GiftClaimError = "gift_count_invalid" | "gift_exceeds_paid_items" | "gift_entitlement_unavailable";

export function validateGiftClaim(args: {
  giftCount: number;
  paidQuantity: number;
  availableEntitlements: number;
}): GiftClaimError | null {
  if (!Number.isInteger(args.giftCount) || args.giftCount < 0) return "gift_count_invalid";
  if (args.giftCount > args.paidQuantity) return "gift_exceeds_paid_items";
  if (args.giftCount > args.availableEntitlements) return "gift_entitlement_unavailable";
  return null;
}

export function shanghaiBusinessDate(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

const ERRORS: Array<[RegExp, number, string]> = [
  [/fankuang gift exceeds paid items/i, 422, "gift_exceeds_paid_items"],
  [/fankuang gift entitlement unavailable/i, 409, "gift_entitlement_unavailable"],
  [/fankuang gift sku not purchasable/i, 422, "gift_sku_not_purchasable"],
  [/fankuang gift idempotency conflict/i, 409, "gift_idempotency_conflict"],
  [/fankuang gift sku not configured/i, 503, "gift_not_configured"],
  [/fankuang gift sku invalid/i, 503, "gift_sku_invalid"],
  [/fankuang gift requires paid order/i, 422, "gift_requires_paid_items"],
  [/fankuang gift count mismatch/i, 400, "gift_invalid"],
  [/fankuang (missing|unknown) create argument|fankuang create function (overloaded|missing|signature unsupported)/i, 500, "gift_checkout_misconfigured"],
  [/fankuang client op conflict/i, 409, "client_op_conflict"],
  [/fankuang listing not in session/i, 422, "listing_not_in_session"],
  [/fankuang session not found/i, 404, "session_not_found"],
  [/fankuang basket empty/i, 404, "basket_empty"],
];

export function mapFankuangDbError(message: string): { status: number; code: string } | null {
  for (const [re, status, code] of ERRORS) if (re.test(message)) return { status, code };
  return null;
}
