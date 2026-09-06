// 履约访问与写入授权、以及 can_complete_pick 的服务端真实判定。
// 契约要点：
// - 普通员工严格限制在「设备当前绑定库位」；HQ 按目标子单所在 location 授权，不依赖 HQ 设备绑定库位。
// - 任何父订单 cancelled / closed 一律禁止写操作。
// - can_complete_pick 由服务端计算，pending_customer 缺货与 refund_pending 退款一律阻止。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  userCanAccessLocation,
  err,
  loadUserRoles,
  type DeviceContext,
} from "@/server/handheld-auth.server";

/** 原生端契约：数值版本号（不是字符串），便于客户端做 >= 比较。 */
export const FULFILLMENT_WORKFLOW_VERSION = 1;

export const BLOCKING_ORDER_STATUSES = ["cancelled", "closed"] as const;

export type AccessMode = "read" | "write";

export type AccessDecision =
  | { ok: true; scope: string }
  | { ok: false; code: string; status: number; message: string };

/**
 * 纯函数：给定角色/库位/订单状态，判定是否允许访问目标子单。
 */
export function evaluateFulfillmentAccess(input: {
  mode: AccessMode;
  isHq: boolean;
  deviceLocationId: string | null;
  fulfillmentLocationId: string;
  userAllowedAtFulfillmentLocation: boolean;
  orderStatus: string | null;
}): AccessDecision {
  const { mode, isHq, deviceLocationId, fulfillmentLocationId } = input;

  if (!isHq) {
    // 普通员工：只能操作设备当前授权库位下的子单。
    if (!deviceLocationId || deviceLocationId !== fulfillmentLocationId) {
      return {
        ok: false,
        code: "location_forbidden",
        status: 403,
        message: "You do not have permission to operate this location",
      };
    }
  }
  // HQ 与普通员工都必须对目标库位本身有授权（HQ 不依赖设备绑定库位）。
  if (!input.userAllowedAtFulfillmentLocation) {
    return {
      ok: false,
      code: "location_forbidden",
      status: 403,
      message: "You do not have permission to operate this location",
    };
  }

  if (
    mode === "write" &&
    BLOCKING_ORDER_STATUSES.includes((input.orderStatus ?? "") as (typeof BLOCKING_ORDER_STATUSES)[number])
  ) {
    return {
      ok: false,
      code: "order_cancelled",
      status: 409,
      message: "Parent order is cancelled or closed; writes are blocked",
    };
  }

  return { ok: true, scope: `location:${fulfillmentLocationId}` };
}

export type ShortageRow = {
  fulfillment_item_id: string;
  status: string;
  refund_state: string | null;
};

export type PickGuardInput = {
  fulfillmentStatus: string;
  orderCancelled: boolean;
  items: Array<{ id: string; expected_qty: number; picked_qty: number }>;
  shortages: ShortageRow[];
};

export type PickGuard = {
  can_complete_pick: boolean;
  blocked_reasons: string[];
  unpicked_line_count: number;
  pending_customer_count: number;
  refund_pending_count: number;
};

/** 纯函数：服务端真实判定 can_complete_pick。 */
export function computePickGuard(input: PickGuardInput): PickGuard {
  const reasons: string[] = [];
  if (input.orderCancelled) reasons.push("order_cancelled");

  const pendingCustomer = input.shortages.filter((s) => s.status === "pending_customer").length;
  if (pendingCustomer > 0) reasons.push("shortage_pending_customer");

  const refundPending = input.shortages.filter((s) => s.refund_state === "refund_pending").length;
  if (refundPending > 0) reasons.push("refund_pending");

  // 缺货已被客户确认取消的行不再要求拣满。
  const acceptedItemIds = new Set(
    input.shortages.filter((s) => s.status === "customer_accepted").map((s) => s.fulfillment_item_id),
  );
  const unpicked = input.items.filter(
    (it) =>
      Number(it.picked_qty ?? 0) < Number(it.expected_qty ?? 0) && !acceptedItemIds.has(it.id),
  ).length;
  if (unpicked > 0) reasons.push("lines_unpicked");

  if (!["allocated", "picking", "picked"].includes(input.fulfillmentStatus)) {
    reasons.push(`status_${input.fulfillmentStatus}`);
  }

  return {
    can_complete_pick: reasons.length === 0,
    blocked_reasons: reasons,
    unpicked_line_count: unpicked,
    pending_customer_count: pendingCustomer,
    refund_pending_count: refundPending,
  };
}

export type FulfillmentContext = {
  id: string;
  location_id: string;
  status: string;
  order_id: string;
  order_status: string | null;
  payment_status: string | null;
};

export async function loadFulfillmentContext(
  fulfillmentId: string,
): Promise<FulfillmentContext | null> {
  const { data } = await supabaseAdmin
    .from("fulfillments" as never)
    .select("id, location_id, status, order_id, order:commerce_orders!order_id(order_status, payment_status)")
    .eq("id", fulfillmentId)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as {
    id: string;
    location_id: string;
    status: string;
    order_id: string;
    order: { order_status: string | null; payment_status: string | null } | null;
  };
  return {
    id: row.id,
    location_id: row.location_id,
    status: row.status,
    order_id: row.order_id,
    order_status: row.order?.order_status ?? null,
    payment_status: row.order?.payment_status ?? null,
  };
}

export async function isHq(userId: string): Promise<boolean> {
  const roles = await loadUserRoles(userId);
  return roles.includes("super_admin") || roles.includes("hq_operator");
}

/**
 * 路由级统一授权：设备 + 员工 session + 目标子单库位 + 订单可写状态。
 * HQ 走目标子单 location 授权，普通员工严格限定设备当前库位。
 */
export async function authorizeFulfillment(input: {
  device: DeviceContext;
  session: { user_id: string } | null;
  fulfillmentId: string;
  mode: AccessMode;
}): Promise<
  | {
      ok: true;
      userId: string;
      isHq: boolean;
      scope: string;
      fulfillment: FulfillmentContext;
    }
  | { ok: false; response: Response }
> {
  if (!input.session) {
    return {
      ok: false,
      response: err("Employee session required", 401, { code: "session_required" }),
    };
  }
  const userId = input.session.user_id;
  const context = await loadFulfillmentContext(input.fulfillmentId);
  if (!context) {
    return { ok: false, response: err("Fulfillment not found", 404, { code: "not_found" }) };
  }
  const hq = await isHq(userId);
  const allowed = await userCanAccessLocation(userId, context.location_id);
  const decision = evaluateFulfillmentAccess({
    mode: input.mode,
    isHq: hq,
    deviceLocationId: input.device.location_id ?? null,
    fulfillmentLocationId: context.location_id,
    userAllowedAtFulfillmentLocation: allowed,
    orderStatus: context.order_status,
  });
  if (!decision.ok) {
    return {
      ok: false,
      response: err(decision.message, decision.status, { code: decision.code }),
    };
  }
  return { ok: true, userId, isHq: hq, scope: decision.scope, fulfillment: context };
}

/** 读取子单行 + 缺货，真实计算 can_complete_pick 与每行 shortage_status。 */
export async function loadPickGuard(context: FulfillmentContext): Promise<{
  guard: PickGuard;
  shortageByItem: Map<string, { status: string; refund_state: string | null }>;
}> {
  const [{ data: itemRows }, { data: shortageRows }] = await Promise.all([
    supabaseAdmin
      .from("fulfillment_items" as never)
      .select("id, expected_qty, picked_qty")
      .eq("fulfillment_id", context.id),
    supabaseAdmin
      .from("fulfillment_shortages" as never)
      .select("fulfillment_item_id, status, refund_state, created_at")
      .eq("fulfillment_id", context.id)
      .order("created_at", { ascending: true }),
  ]);
  const items =
    (itemRows as unknown as Array<{ id: string; expected_qty: number; picked_qty: number }> | null) ??
    [];
  const shortages = (shortageRows as unknown as ShortageRow[] | null) ?? [];
  const shortageByItem = new Map<string, { status: string; refund_state: string | null }>();
  for (const row of shortages) {
    shortageByItem.set(row.fulfillment_item_id, {
      status: row.status,
      refund_state: row.refund_state ?? null,
    });
  }
  const guard = computePickGuard({
    fulfillmentStatus: context.status,
    orderCancelled: BLOCKING_ORDER_STATUSES.includes(
      (context.order_status ?? "") as (typeof BLOCKING_ORDER_STATUSES)[number],
    ),
    items,
    shortages,
  });
  return { guard, shortageByItem };
}
