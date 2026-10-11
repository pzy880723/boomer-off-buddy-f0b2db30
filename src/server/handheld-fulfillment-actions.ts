// 手持/网页共用的履约动作：自提备货/核销（既有 RPC）与手工录快递单号（单一事务 RPC）。
// actor 只来自已验证员工会话，库位只来自设备绑定；客户端不得传 user_id/location_id。
import { z } from "zod";
import { parsePickupInput, pickupResultMessage } from "@/lib/commerce/pickup-view";

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
export type ActionResponse = { status: number; body: Record<string, unknown> & { ok: boolean } };

const Idem = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
export const PickupRedeemBody = z
  .object({ input: z.string().max(200), idempotency_key: Idem, expected_fulfillment_id: z.string().uuid().optional() })
  .strict();
export const PickupReadyBody = z.object({ fulfillment_id: z.string().uuid(), idempotency_key: Idem }).strict();
export const ManualShipBody = z
  .object({
    provider: z.enum(["sf", "cainiao"]),
    tracking_no: z.string().trim().regex(/^[A-Za-z0-9-]{4,64}$/),
    client_op_id: z.string().trim().regex(/^[A-Za-z0-9_-]{6,80}$/),
    lines: z.array(z.object({ fulfillment_item_id: z.string().uuid(), quantity: z.number().int().min(1).max(99999) }).strict()).min(1).max(200),
  })
  .strict();

/** 网页旧输入框为自由文本：只认顺丰/菜鸟的常见写法，其余拒绝（数据库约束仅 sf/cainiao）。 */
export function normalizeShipProvider(raw: string): "sf" | "cainiao" | null {
  const v = raw.trim().toLowerCase();
  if (["sf", "顺丰", "顺丰速运", "sf express"].includes(v)) return "sf";
  if (["cainiao", "菜鸟", "菜鸟裹裹"].includes(v)) return "cainiao";
  return null;
}

const PICKUP_STATUS: Record<string, number> = {
  redeemed: 200, ready: 200, already_ready: 200,
  invalid_input: 400, forbidden: 403, wrong_location: 403,
  not_found: 404, not_found_fulfillment: 404, rate_limited: 429,
};
export function pickupHttpStatus(result: string): number {
  return PICKUP_STATUS[result] ?? 409;
}

const SHIP_STATUS: Record<string, number> = {
  shipped: 200, invalid_provider: 400, invalid_tracking_no: 400, invalid_idempotency_key: 400,
  forbidden: 403, location_forbidden: 403, not_found: 404, invalid_lines: 422, qty_exceeded: 422,
};
export const SHIP_MESSAGES: Record<string, string> = {
  shipped: "已登记发货", forbidden: "你没有该门店的发货权限", location_forbidden: "该子单不属于本设备门店",
  not_found: "子单不存在", pickup_order: "门店自提订单请使用提货码核销，不能登记快递发货",
  unpaid: "订单未付款，不能发货", refund_blocked: "订单退款处理中或已退款，不能发货",
  cancelled: "订单已取消或关闭", after_sale_blocked: "订单售后处理中，不能发货",
  invalid_status: "子单当前状态不能登记发货", already_shipped: "该子单已登记过发货",
  idempotency_conflict: "同一操作编号已用于不同的发货内容", invalid_lines: "发货明细与子单不符",
  qty_exceeded: "本次发货数量超过待发数量", invalid_provider: "仅支持顺丰或菜鸟",
  invalid_tracking_no: "运单号格式不正确", invalid_idempotency_key: "操作编号格式不正确",
};

function rpcFailure(): ActionResponse {
  return { status: 503, body: { ok: false, result: "service_unavailable", message: "服务暂时不可用，请稍后重试；结果未知时请用同一操作编号重试" } };
}

function pickupResponse(data: unknown): ActionResponse {
  const r = (data ?? {}) as Record<string, unknown>;
  const result = typeof r.result === "string" ? r.result : "unknown";
  const ok = r.ok === true;
  return {
    status: ok ? 200 : pickupHttpStatus(result),
    body: {
      ok, result, message: pickupResultMessage(result),
      ...(typeof r.fulfillment_id === "string" ? { fulfillment_id: r.fulfillment_id } : {}),
      ...(typeof r.order_id === "string" ? { order_id: r.order_id } : {}),
      ...(typeof r.redeemed_at === "string" ? { redeemed_at: r.redeemed_at } : {}),
      replayed: r.replayed === true,
    },
  };
}

export async function handheldPickupRedeem(
  rpc: Rpc,
  i: { actorUserId: string; locationId: string; input: string; idempotencyKey: string; expectedFulfillmentId?: string | null },
): Promise<ActionResponse> {
  const parsed = parsePickupInput(i.input);
  if (!parsed) return { status: 400, body: { ok: false, result: "invalid_input", message: pickupResultMessage("invalid_input") } };
  const { data, error } = await rpc("commerce_pickup_redeem", {
    p_actor_user_id: i.actorUserId, p_location_id: i.locationId,
    p_qr_payload: parsed.kind === "qr" ? parsed.value : null,
    p_code: parsed.kind === "code" ? parsed.value : null,
    p_idempotency_key: i.idempotencyKey, p_expected_fulfillment_id: i.expectedFulfillmentId ?? null,
  });
  return error ? rpcFailure() : pickupResponse(data);
}

export async function handheldPickupReady(
  rpc: Rpc,
  i: { actorUserId: string; locationId: string; fulfillmentId: string; idempotencyKey: string },
): Promise<ActionResponse> {
  const { data, error } = await rpc("commerce_pickup_mark_ready", {
    p_actor_user_id: i.actorUserId, p_location_id: i.locationId,
    p_fulfillment_id: i.fulfillmentId, p_idempotency_key: i.idempotencyKey,
  });
  if (error) return rpcFailure();
  const r = pickupResponse(data);
  if (r.body.result === "not_found") return { status: 404, body: { ...r.body, message: pickupResultMessage("not_found_fulfillment") } };
  return r;
}

export async function manualShip(
  rpc: Rpc,
  i: {
    actorUserId: string; locationId: string | null; fulfillmentId: string; provider: string;
    trackingNo: string; lines: Array<{ fulfillmentItemId: string; quantity: number }>; idempotencyKey: string;
  },
): Promise<ActionResponse> {
  const { data, error } = await rpc("commerce_manual_ship_fulfillment", {
    p_actor_user_id: i.actorUserId, p_location_id: i.locationId, p_fulfillment_id: i.fulfillmentId,
    p_provider: i.provider, p_tracking_no: i.trackingNo,
    p_lines: i.lines.map((l) => ({ fulfillment_item_id: l.fulfillmentItemId, quantity: l.quantity })),
    p_idempotency_key: i.idempotencyKey,
  });
  if (error) return rpcFailure();
  const r = (data ?? {}) as Record<string, unknown>;
  const result = typeof r.result === "string" ? r.result : "unknown";
  const ok = r.ok === true;
  return {
    status: ok ? 200 : (SHIP_STATUS[result] ?? 409),
    body: {
      ok, result, message: SHIP_MESSAGES[result] ?? "登记发货失败",
      ...(ok ? { replayed: r.replayed === true, shipment: { id: r.shipment_id, fulfillment_id: r.fulfillment_id, provider: r.provider, tracking_no: r.tracking_no, status: "booked" } } : {}),
    },
  };
}
