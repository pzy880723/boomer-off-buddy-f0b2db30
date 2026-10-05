// 客服 M1 纯业务策略（无 IO，可单测）。数据库 RPC 是最终裁决，这里只负责展示能力与中文错误。
export type SupportAssignmentAction = "claim" | "takeover" | "close" | "reopen";
export type SupportChannel = "native" | "wechat_kf";

export type SupportPolicyAccess = { user_id: string; is_hq_agent: boolean; location_ids: string[] };
export type SupportPolicyConversation = {
  location_id: string | null;
  status: string;
  primary_agent_id: string | null;
  channel?: string;
};

export function canAccessLocation(access: SupportPolicyAccess, locationId: string | null): boolean {
  if (access.is_hq_agent) return true;
  return !!locationId && access.location_ids.includes(locationId);
}

export function supportCapabilities(access: SupportPolicyAccess, c: SupportPolicyConversation) {
  const allowed = canAccessLocation(access, c.location_id);
  const open = c.status !== "closed";
  const isPrimary = c.primary_agent_id === access.user_id;
  // 与 support_update_assignment 一致：关闭/重开仅主接待人或总部；微信渠道未接入外发
  const ownerOrHq = allowed && (access.is_hq_agent || isPrimary);
  const channelConnected = (c.channel ?? "native") === "native";
  return {
    can_note: allowed,
    can_reply: allowed && open && isPrimary && channelConnected,
    can_claim: allowed && open && c.primary_agent_id === null,
    can_takeover: access.is_hq_agent && open && !isPrimary,
    can_close: ownerOrHq && open,
    can_reopen: ownerOrHq && !open,
  };
}

/** 订单上下文门店：所有行同一履约门店才归该店；跨店 / 无门店一律归总部（null）。 */
export function deriveOrderLocation(lineLocationIds: (string | null)[]): string | null {
  const set = new Set(lineLocationIds);
  if (set.size !== 1) return null;
  const [only] = [...set];
  return only ?? null;
}

export function buildContextKey(input: {
  orderId?: string | null;
  productId?: string | null;
  locationId?: string | null;
}): string {
  if (input.orderId) return `order:${input.orderId}`;
  if (input.productId) return `product:${input.productId}`;
  return input.locationId ? `general:${input.locationId}` : "general";
}

export const SUPPORT_QUEUES = ["unclaimed", "mine", "escalated", "closed", "all"] as const;
export type SupportQueue = (typeof SUPPORT_QUEUES)[number];

/** 稳定分页游标：updated_at + id，避免 updated_at 相同的会话被跳过。 */
export function encodeSupportCursor(row: { updated_at: string; id: string }): string {
  return `${row.updated_at}|${row.id}`;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function decodeSupportCursor(cursor: string | null | undefined):
  | { updated_at: string; id: string }
  | null
  | "invalid" {
  if (!cursor) return null;
  const [ts, id, extra] = cursor.split("|");
  if (extra !== undefined || !ts || !id || !UUID_RE.test(id) || Number.isNaN(Date.parse(ts))) {
    return "invalid";
  }
  return { updated_at: ts, id };
}

export const SUPPORT_ERRORS: Record<string, { status: number; message: string }> = {
  not_found: { status: 404, message: "会话不存在或无权查看" },
  forbidden: { status: 403, message: "无权处理该门店的会话" },
  primary_or_hq_only: { status: 403, message: "只有主接待人或总部可以关闭/重开会话" },
  channel_not_connected: { status: 409, message: "微信客服渠道尚未接通，暂不能对外回复，可先写内部备注" },
  hq_only: { status: 403, message: "只有总部客服可以接管会话" },
  invalid_action: { status: 400, message: "不支持的操作" },
  assignment_version_required: { status: 409, message: "会话状态已更新，请刷新后再操作" },
  version_conflict: { status: 409, message: "会话已被其他人领取或变更，请刷新后再操作" },
  already_claimed: { status: 409, message: "该会话已有主接待人，如需处理请由总部接管" },
  claim_required: { status: 409, message: "请先领取会话，再对客户回复" },
  not_primary_agent: { status: 403, message: "你不是当前主接待人，只能写内部备注" },
  conversation_closed: { status: 409, message: "会话已关闭，请先重开" },
  conversation_not_closed: { status: 409, message: "会话未关闭，无需重开" },
  client_op_id_conflict: { status: 409, message: "消息编号重复，请重新发送" },
  client_op_id_required: { status: 400, message: "缺少消息编号" },
  invalid_body: { status: 400, message: "消息内容不能为空且不超过 4000 字" },
  forbidden_location: { status: 403, message: "无权查看该门店" },
  order_not_found: { status: 404, message: "订单不存在或不属于当前账号" },
  product_not_found: { status: 404, message: "商品不存在或已下架" },
  location_not_found: { status: 404, message: "门店不存在" },
  invalid_cursor: { status: 400, message: "分页游标无效，请从第一页重新加载" },
  validation_error: { status: 400, message: "参数不正确" },
};

export function supportError(code: string) {
  return SUPPORT_ERRORS[code] ?? { status: 500, message: "客服服务暂时不可用，请稍后再试" };
}

export class SupportError extends Error {
  code: string;
  status: number;
  detail?: Record<string, unknown>;
  constructor(code: string, detail?: Record<string, unknown>) {
    const e = supportError(code);
    super(`[${code}] ${e.message}`);
    this.code = code;
    this.status = e.status;
    this.detail = detail;
  }
}
