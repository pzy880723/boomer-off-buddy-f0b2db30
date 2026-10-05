// 客服会话：门店员工与总部客服共享同一会话；对外回复由主接待人（primary_agent_id）负责，其他授权协作者写内部备注。
// 授权口径：super_admin / hq_operator / support_agents(scope='hq') → 全部会话；
// 其余员工按 user_location_perms + support_agents(scope='location') 覆盖的 location_id。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadUserRoles } from "@/server/handheld-auth.server";
import {
  buildContextKey,
  deriveOrderLocation,
  supportCapabilities,
  type SupportAssignmentAction,
} from "@/lib/support-policy";

export type SupportContext = { [key: string]: string | number | boolean | null } | null;

/** 只返回展示用安全字段，去掉 image_url 等可能带签名/原图地址的字段。 */
export function safeContext(raw: unknown): SupportContext {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: { [key: string]: string | number | boolean | null } = {};
  for (const k of ["type", "id", "title", "order_no", "price", "sku_code"]) {
    const v = r[k];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

const CONVERSATION_COLUMNS =
  "id,title,location_id,customer_id,order_id,status,topic,last_message_at,last_message_preview,created_at,updated_at,context_key,context,channel,primary_agent_id,assignment_version,escalated_at,escalation_reason,waiting_since";

export type SupportAccess = {
  user_id: string;
  display_name: string;
  is_hq_agent: boolean;
  location_ids: string[];
  participant_role: "hq_agent" | "store_staff";
};

export type SupportConversationSummary = {
  id: string;
  title: string | null;
  location_id: string | null;
  location_name: string | null;
  customer_name: string | null;
  last_message: string | null;
  updated_at: string;
  unread_count: number;
  status: string;
  participants: { user_id: string; name: string; role: string }[];
  channel: string;
  primary_agent_id: string | null;
  primary_agent_name: string | null;
  assignment_version: number;
  escalated_at: string | null;
  escalation_reason: string | null;
  waiting_since: string | null;
  context_key: string | null;
  context: SupportContext;
  can_reply: boolean;
  can_note: boolean;
  can_claim: boolean;
  can_takeover: boolean;
  can_close: boolean;
  can_reopen: boolean;
};

export type SupportMessage = {
  id: string;
  sender_name: string;
  sender_type: "customer" | "staff" | "system";
  body: string;
  internal: boolean;
  delivery_status: "sent" | "pending" | "failed";
  created_at: string;
};

const nameCache = new Map<string, string>();

export async function resolveUserDisplayName(userId: string): Promise<string> {
  const cached = nameCache.get(userId);
  if (cached) return cached;
  const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
  const meta = (data?.user?.user_metadata ?? {}) as { name?: string; full_name?: string };
  const name = meta.name || meta.full_name || data?.user?.email?.split("@")[0] || userId.slice(-6);
  nameCache.set(userId, name);
  return name;
}

export async function resolveSupportAccess(userId: string): Promise<SupportAccess> {
  const roles = await loadUserRoles(userId);
  const { data: agents } = await supabaseAdmin
    .from("support_agents" as never)
    .select("scope, location_id, display_name, is_active")
    .eq("user_id", userId)
    .eq("is_active", true);
  const agentRows =
    (agents as
      | { scope: string; location_id: string | null; display_name: string | null }[]
      | null) ?? [];
  const isHqAgent =
    roles.includes("super_admin") ||
    roles.includes("hq_operator") ||
    agentRows.some((row) => row.scope === "hq");

  let locationIds: string[] = [];
  if (!isHqAgent) {
    const { data: perms } = await supabaseAdmin
      .from("user_location_perms" as never)
      .select("location_id")
      .eq("user_id", userId);
    locationIds = [
      ...new Set([
        ...((perms as { location_id: string }[] | null) ?? []).map((row) => row.location_id),
        ...agentRows
          .map((row) => row.location_id)
          .filter(Boolean as unknown as (v: unknown) => v is string),
      ]),
    ];
  }

  const displayName =
    agentRows.find((row) => row.display_name)?.display_name ??
    (await resolveUserDisplayName(userId));

  return {
    user_id: userId,
    display_name: displayName,
    is_hq_agent: isHqAgent,
    location_ids: locationIds,
    participant_role: isHqAgent ? "hq_agent" : "store_staff",
  };
}

type ConversationRow = {
  id: string;
  title: string | null;
  location_id: string | null;
  customer_id: string | null;
  order_id: string | null;
  status: string;
  topic: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  created_at: string;
  updated_at: string;
  context_key: string | null;
  context: SupportContext;
  channel: string;
  primary_agent_id: string | null;
  assignment_version: number;
  escalated_at: string | null;
  escalation_reason: string | null;
  waiting_since: string | null;
};

export function staffCanAccessConversation(
  access: SupportAccess,
  conversation: { location_id: string | null },
): boolean {
  if (access.is_hq_agent) return true;
  if (!conversation.location_id) return false;
  return access.location_ids.includes(conversation.location_id);
}

async function hydrate(
  rows: ConversationRow[],
  access: SupportAccess,
): Promise<SupportConversationSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const locationIds = [...new Set(rows.map((row) => row.location_id).filter(Boolean))] as string[];
  const customerIds = [...new Set(rows.map((row) => row.customer_id).filter(Boolean))] as string[];

  const [{ data: participants }, { data: locations }, { data: customers }, { data: myRows }] =
    await Promise.all([
      supabaseAdmin
        .from("support_participants" as never)
        .select("conversation_id, user_id, participant_role, display_name")
        .in("conversation_id", ids),
      locationIds.length
        ? supabaseAdmin.from("inv_locations").select("id,name").in("id", locationIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      customerIds.length
        ? supabaseAdmin
            .from("commerce_customers" as never)
            .select("id,nickname,phone")
            .in("id", customerIds)
        : Promise.resolve({ data: [] as { id: string; nickname: string | null }[] }),
      supabaseAdmin
        .from("support_participants" as never)
        .select("conversation_id, last_read_at")
        .eq("user_id", access.user_id)
        .in("conversation_id", ids),
    ]);

  const locationNames = new Map(
    ((locations as { id: string; name: string }[] | null) ?? []).map((r) => [r.id, r.name]),
  );
  const customerNames = new Map(
    (
      (customers as { id: string; nickname: string | null; phone?: string | null }[] | null) ?? []
    ).map((r) => [
      r.id,
      r.nickname || (r.phone ? `${r.phone.slice(0, 3)}****${r.phone.slice(-2)}` : "顾客"),
    ]),
  );
  const lastReads = new Map(
    ((myRows as { conversation_id: string; last_read_at: string | null }[] | null) ?? []).map(
      (r) => [r.conversation_id, r.last_read_at],
    ),
  );
  const participantRows =
    (participants as
      | {
          conversation_id: string;
          user_id: string;
          participant_role: string;
          display_name: string | null;
        }[]
      | null) ?? [];
  const participantNames = new Map<string, string>();
  await Promise.all(
    [
      ...new Set([
        ...participantRows.map((r) => r.user_id),
        ...rows.map((r) => r.primary_agent_id).filter((v): v is string => !!v),
      ]),
    ].map(async (userId) => {
      participantNames.set(userId, await resolveUserDisplayName(userId));
    }),
  );

  // 未读 = 客户发来的、晚于我 last_read_at 的消息数
  const unreadCounts = new Map<string, number>();
  await Promise.all(
    ids.map(async (conversationId) => {
      const lastRead = lastReads.get(conversationId) ?? null;
      let query = supabaseAdmin
        .from("support_messages" as never)
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", conversationId)
        .eq("sender_type", "customer");
      if (lastRead) query = query.gt("created_at", lastRead);
      const { count } = await query;
      unreadCounts.set(conversationId, count ?? 0);
    }),
  );

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    location_id: row.location_id,
    location_name: row.location_id ? (locationNames.get(row.location_id) ?? null) : null,
    customer_name: row.customer_id ? (customerNames.get(row.customer_id) ?? null) : null,
    last_message: row.last_message_preview,
    updated_at: row.updated_at,
    unread_count: unreadCounts.get(row.id) ?? 0,
    status: row.status,
    participants: participantRows
      .filter((p) => p.conversation_id === row.id)
      .map((p) => ({
        user_id: p.user_id,
        name: p.display_name ?? participantNames.get(p.user_id) ?? p.user_id.slice(-6),
        role: p.participant_role,
      })),
    channel: row.channel,
    primary_agent_id: row.primary_agent_id,
    primary_agent_name: row.primary_agent_id
      ? (participantRows.find((p) => p.user_id === row.primary_agent_id && p.conversation_id === row.id)
          ?.display_name ??
        participantNames.get(row.primary_agent_id) ??
        null)
      : null,
    assignment_version: row.assignment_version,
    escalated_at: row.escalated_at,
    escalation_reason: row.escalation_reason,
    waiting_since: row.waiting_since,
    context_key: row.context_key,
    // 列表只含授权会话；context 仅在授权范围内返回
    context: staffCanAccessConversation(access, row) ? safeContext(row.context) : null,
    ...supportCapabilities(access, row),
  }));
}

/**
 * 服务端强制授权：HQ 不传 location_id 表示"全部授权门店"，传了必须是真实门店；
 * 分店员工必须传本店，且只能是自己被授权的门店，否则 forbidden。
 */
export function resolveConversationLocationFilter(
  access: SupportAccess,
  locationId: string | null | undefined,
): { ok: true; location_id: string | null } | { ok: false; code: "forbidden_location" } {
  const wanted = locationId?.trim() ? locationId.trim() : null;
  if (access.is_hq_agent) return { ok: true, location_id: wanted };
  if (!wanted) return { ok: true, location_id: null }; // 退化为全部授权门店，仍受授权过滤
  if (!access.location_ids.includes(wanted)) return { ok: false, code: "forbidden_location" };
  return { ok: true, location_id: wanted };
}

export async function listStaffConversations(input: {
  access: SupportAccess;
  status?: string | null;
  limit?: number;
  cursor?: string | null;
  location_id?: string | null;
}): Promise<{ items: SupportConversationSummary[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  if (!input.access.is_hq_agent && input.access.location_ids.length === 0) {
    return { items: [], next_cursor: null };
  }
  let query = supabaseAdmin
    .from("support_conversations" as never)
    .select(CONVERSATION_COLUMNS)
    .order("updated_at", { ascending: false })
    .limit(limit + 1);
  if (!input.access.is_hq_agent) query = query.in("location_id", input.access.location_ids);
  if (input.location_id) query = query.eq("location_id", input.location_id);
  if (input.status) query = query.eq("status", input.status);
  if (input.cursor) query = query.lt("updated_at", input.cursor);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data as unknown as ConversationRow[]) ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: await hydrate(page, input.access),
    next_cursor: hasMore ? (page[page.length - 1]?.updated_at ?? null) : null,
  };
}

export async function loadConversationRow(id: string): Promise<ConversationRow | null> {
  const { data } = await supabaseAdmin
    .from("support_conversations" as never)
    .select(CONVERSATION_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  return (data as unknown as ConversationRow) ?? null;
}

async function loadMessages(
  conversationId: string,
  includeInternal: boolean,
): Promise<SupportMessage[]> {
  let query = supabaseAdmin
    .from("support_messages" as never)
    .select("id, sender_name, sender_type, body, internal, delivery_status, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(500);
  if (!includeInternal) query = query.eq("internal", false).eq("delivery_status", "sent");
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data as unknown as SupportMessage[]) ?? []).map((row) => ({
    id: row.id,
    sender_name: row.sender_name,
    sender_type: row.sender_type,
    body: row.body,
    internal: row.internal,
    delivery_status: row.delivery_status ?? "sent",
    created_at: row.created_at,
  }));
}

/** 员工打开会话：自动成为参与人（共享接待，不独占），并刷新已读水位。 */
export async function joinConversation(access: SupportAccess, conversationId: string) {
  await supabaseAdmin.from("support_participants" as never).upsert(
    {
      conversation_id: conversationId,
      user_id: access.user_id,
      participant_role: access.participant_role,
      display_name: access.display_name,
      last_read_at: new Date().toISOString(),
    } as never,
    { onConflict: "conversation_id,user_id" },
  );
}

export async function getStaffConversation(access: SupportAccess, conversationId: string) {
  const conversation = await loadConversationRow(conversationId);
  if (!conversation) return { ok: false as const, code: "not_found" };
  if (!staffCanAccessConversation(access, conversation)) {
    return { ok: false as const, code: "forbidden" };
  }
  await joinConversation(access, conversationId);
  const [summary] = await hydrate([conversation], access);
  return {
    ok: true as const,
    data: {
      conversation: { ...summary, order_id: conversation.order_id, topic: conversation.topic },
      messages: await loadMessages(conversationId, true),
      can_reply: summary.can_reply,
      can_note: summary.can_note,
    },
  };
}

type RpcResult = {
  ok: boolean;
  code?: string;
  replayed?: boolean;
  message?: Record<string, unknown>;
  assignment_version?: number;
  primary_agent_id?: string | null;
  status?: string;
};

function pickMessage(m: Record<string, unknown> | undefined): SupportMessage | null {
  if (!m) return null;
  return {
    id: String(m.id),
    sender_name: String(m.sender_name),
    sender_type: m.sender_type as SupportMessage["sender_type"],
    body: String(m.body),
    internal: Boolean(m.internal),
    delivery_status: (m.delivery_status as SupportMessage["delivery_status"]) ?? "sent",
    created_at: String(m.created_at),
  };
}

/**
 * 员工发消息：对外回复必须是主接待人且带当前 assignment_version；内部备注任何授权协作者可写。
 * 授权、版本、幂等、insert 在数据库同一事务内完成（support_staff_post_message）。
 * wechat_kf 渠道对外消息落库为 pending，尚未接入微信外发，绝不显示为已发送。
 */
export async function postStaffMessage(input: {
  access: SupportAccess;
  conversationId: string;
  body: string;
  internal: boolean;
  clientOpId: string;
  assignmentVersion?: number | null;
}) {
  const { data, error } = await supabaseAdmin.rpc("support_staff_post_message" as never, {
    p_conversation_id: input.conversationId,
    p_actor: input.access.user_id,
    p_actor_name: input.access.display_name,
    p_participant_role: input.access.participant_role,
    p_body: input.body,
    p_internal: input.internal,
    p_client_op_id: input.clientOpId,
    p_expected_version: input.assignmentVersion ?? null,
  } as never);
  if (error) throw new Error(error.message);
  const r = data as unknown as RpcResult;
  if (!r.ok) {
    return {
      ok: false as const,
      code: r.code ?? "unknown",
      detail: { assignment_version: r.assignment_version, primary_agent_id: r.primary_agent_id },
    };
  }
  return {
    ok: true as const,
    data: { message: pickMessage(r.message), replayed: Boolean(r.replayed) },
  };
}

export async function updateConversationAssignment(input: {
  access: SupportAccess;
  conversationId: string;
  action: SupportAssignmentAction;
  assignmentVersion: number | null;
}) {
  const { data, error } = await supabaseAdmin.rpc("support_update_assignment" as never, {
    p_conversation_id: input.conversationId,
    p_actor: input.access.user_id,
    p_action: input.action,
    p_expected_version: input.assignmentVersion,
  } as never);
  if (error) throw new Error(error.message);
  const r = data as unknown as RpcResult;
  if (!r.ok) {
    return {
      ok: false as const,
      code: r.code ?? "unknown",
      detail: { assignment_version: r.assignment_version, primary_agent_id: r.primary_agent_id },
    };
  }
  if (input.action === "claim" || input.action === "takeover") {
    await joinConversation(input.access, input.conversationId);
  }
  const fresh = await getStaffConversation(input.access, input.conversationId);
  return {
    ok: true as const,
    data: {
      code: r.code,
      assignment_version: r.assignment_version,
      primary_agent_id: r.primary_agent_id ?? null,
      status: r.status,
      conversation: fresh.ok ? fresh.data.conversation : null,
    },
  };
}

/** 超时升级（幂等，数据库时间）：供管理员服务器 worker 调用，不自动排程。 */
export async function runSupportEscalation(unclaimedSeconds = 60, replySeconds = 180) {
  const { data, error } = await supabaseAdmin.rpc("support_escalate_overdue" as never, {
    p_unclaimed_seconds: unclaimedSeconds,
    p_reply_seconds: replySeconds,
  } as never);
  if (error) throw new Error(error.message);
  return data as unknown as { escalated: number; conversation_ids: string[]; checked_at: string };
}

// ---------- 消费者侧 ----------

export async function listCustomerConversations(customerId: string) {
  const { data, error } = await supabaseAdmin
    .from("support_conversations" as never)
    .select("id,title,status,location_id,order_id,last_message_at,last_message_preview,updated_at")
    .eq("customer_id", customerId)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as Array<Record<string, unknown>>;
}

/**
 * 顾客开会话：订单必须属于该顾客；订单/商品上下文门店由服务端派生（跨店订单归总部 null）；
 * 已开放会话按 customer + context_key 隔离复用，不跨门店复用。
 */
export async function ensureCustomerConversation(input: {
  customerId: string;
  customerName: string;
  locationId?: string | null;
  orderId?: string | null;
  productId?: string | null;
  title?: string | null;
  topic?: string;
}): Promise<{ ok: true; id: string; reused: boolean } | { ok: false; code: string }> {
  let locationId: string | null = null;
  let context: Record<string, unknown> | null = null;
  let orderId: string | null = null;
  let productId: string | null = null;

  if (input.orderId) {
    const { data: order } = await supabaseAdmin
      .from("commerce_orders" as never)
      .select("id, customer_id, order_no")
      .eq("id", input.orderId)
      .maybeSingle();
    const o = order as { id: string; customer_id: string | null; order_no: string | null } | null;
    if (!o || o.customer_id !== input.customerId) return { ok: false, code: "order_not_found" };
    const { data: lines } = await supabaseAdmin
      .from("commerce_order_items" as never)
      .select("location_id")
      .eq("order_id", o.id);
    locationId = deriveOrderLocation(
      ((lines as { location_id: string | null }[] | null) ?? []).map((l) => l.location_id),
    );
    orderId = o.id;
    context = { type: "order", id: o.id, order_no: o.order_no };
  } else if (input.productId) {
    const { data: listing } = await supabaseAdmin
      .from("commerce_listings" as never)
      .select("id, location_id, title, price, status")
      .eq("id", input.productId)
      .maybeSingle();
    const l = listing as {
      id: string;
      location_id: string | null;
      title: string | null;
      price: number | null;
      status: string | null;
    } | null;
    // 仅已上架商品可发起商品咨询；已售/下架请走订单咨询
    if (!l || l.status !== "published") return { ok: false, code: "product_not_found" };
    locationId = l.location_id;
    productId = l.id;
    context = { type: "product", id: l.id, title: l.title, price: l.price };
  } else if (input.locationId) {
    const { data: loc } = await supabaseAdmin
      .from("inv_locations")
      .select("id")
      .eq("id", input.locationId)
      .maybeSingle();
    if (!loc) return { ok: false, code: "location_not_found" };
    locationId = input.locationId;
  }

  const contextKey = buildContextKey({ orderId, productId, locationId });
  const findOpen = async () => {
    const { data } = await supabaseAdmin
      .from("support_conversations" as never)
      .select("id")
      .eq("customer_id", input.customerId)
      .eq("context_key", contextKey)
      .in("status", ["open", "pending"])
      .limit(1)
      .maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  };
  const existing = await findOpen();
  if (existing) return { ok: true, id: existing, reused: true };
  const { data, error } = await supabaseAdmin
    .from("support_conversations" as never)
    .insert({
      customer_id: input.customerId,
      location_id: locationId,
      order_id: orderId,
      context_key: contextKey,
      context,
      channel: "native",
      title: input.title ?? `${input.customerName} 的咨询`,
      topic: input.topic ?? (orderId ? "order" : productId ? "product" : "general"),
    } as never)
    .select("id")
    .single();
  if (error) {
    // 并发创建撞唯一索引 uq_support_active_customer_context → 复用已存在会话
    if (/duplicate key/i.test(error.message)) {
      const raced = await findOpen();
      if (raced) return { ok: true, id: raced, reused: true };
    }
    throw new Error(error.message);
  }
  return { ok: true, id: (data as { id: string }).id, reused: false };
}

export async function getCustomerConversation(customerId: string, conversationId: string) {
  const conversation = await loadConversationRow(conversationId);
  if (!conversation || conversation.customer_id !== customerId) {
    return { ok: false as const, code: "not_found" };
  }
  return {
    ok: true as const,
    data: {
      conversation: {
        id: conversation.id,
        title: conversation.title,
        status: conversation.status,
        order_id: conversation.order_id,
        location_id: conversation.location_id,
        context: safeContext(conversation.context),
        updated_at: conversation.updated_at,
      },
      // 客户永远看不到内部备注
      messages: await loadMessages(conversationId, false),
      can_reply: conversation.status !== "closed",
    },
  };
}

/** 顾客发送：数据库行锁事务（support_customer_post_message），与关闭竞争时关闭后不可插入。 */
export async function postCustomerMessage(input: {
  customerId: string;
  customerName: string;
  conversationId: string;
  body: string;
  clientOpId: string;
}) {
  const { data, error } = await supabaseAdmin.rpc("support_customer_post_message" as never, {
    p_conversation_id: input.conversationId,
    p_customer_id: input.customerId,
    p_customer_name: input.customerName,
    p_body: input.body,
    p_client_op_id: input.clientOpId,
  } as never);
  if (error) throw new Error(error.message);
  const r = data as unknown as RpcResult;
  if (!r.ok) return { ok: false as const, code: r.code ?? "unknown" };
  return {
    ok: true as const,
    data: { message: pickMessage(r.message), replayed: Boolean(r.replayed) },
  };
}
