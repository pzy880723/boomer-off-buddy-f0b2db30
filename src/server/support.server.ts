// 客服会话：门店员工与总部客服共享同一会话；对外回复由主接待人（primary_agent_id）负责，其他授权协作者写内部备注。
// 授权口径：super_admin / hq_operator / support_agents(scope='hq') → 全部会话；
// 其余员工按 user_location_perms + support_agents(scope='location') 覆盖的 location_id。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadUserRoles } from "@/server/handheld-auth.server";
import { safePublicAvatarUrl, senderPresentation, type SupportSenderPresentation } from "@/lib/support-avatar-policy";
import {
  buildContextKey,
  deriveOrderLocation,
  supportCapabilities,
  decodeSupportCursor,
  encodeSupportCursor,
  type SupportAssignmentAction,
  type SupportQueue,
} from "@/lib/support-policy";
import {
  cursorFilter,
  shapeMessageWindow,
  assertConversationLocation,
  type MessageWindow,
} from "@/lib/support-message-window";

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
  customer_avatar_url: string | null;
  last_message: string | null;
  updated_at: string;
  /** 最近一条顾客消息时间（前台通知去重用），无顾客消息为 null */
  last_customer_message_at: string | null;
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

export type SupportMessage = SupportSenderPresentation & {
  id: string;
  sender_name: string;
  sender_type: "customer" | "staff" | "system";
  body: string;
  internal: boolean;
  delivery_status: "sent" | "pending" | "failed";
  created_at: string;
  /** 仅员工端：该消息是否由当前登录员工发送。顾客端不返回此字段。 */
  is_mine?: boolean;
};

/** 员工名称/可信头像短缓存（进程内 5 分钟），避免详情每 3 秒轮询都调用 admin.getUserById。 */
const STAFF_CACHE_TTL_MS = 5 * 60_000;
type StaffProfile = { name: string; hq_avatar_url: string | null };
const staffCache = new Map<string, { at: number; value: Promise<StaffProfile> }>();

function loadStaffProfile(userId: string): Promise<StaffProfile> {
  const hit = staffCache.get(userId);
  if (hit && Date.now() - hit.at < STAFF_CACHE_TTL_MS) return hit.value;
  const value = supabaseAdmin.auth.admin.getUserById(userId).then(({ data, error }) => {
    if (error) {
      staffCache.delete(userId); // 失败不缓存
      return { name: userId.slice(-6), hq_avatar_url: null };
    }
    const meta = (data?.user?.user_metadata ?? {}) as { name?: string; full_name?: string };
    return {
      name: meta.name || meta.full_name || data?.user?.email?.split("@")[0] || userId.slice(-6),
      // user_metadata 可被本人修改，不可信；只认服务端控制的 app_metadata
      hq_avatar_url: safePublicAvatarUrl(data?.user?.app_metadata?.avatar_url),
    };
  });
  staffCache.set(userId, { at: Date.now(), value });
  return value;
}

export async function resolveUserDisplayName(userId: string): Promise<string> {
  return (await loadStaffProfile(userId)).name;
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
            .select("id,nickname,phone,avatar_url")
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
  const customerAvatars = new Map(
    ((customers as { id: string; avatar_url?: string | null }[] | null) ?? [])
      .map((r) => [r.id, safePublicAvatarUrl(r.avatar_url)]),
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
  const lastCustomerAt = new Map<string, string | null>();
  await Promise.all(
    ids.map(async (conversationId) => {
      const lastRead = lastReads.get(conversationId) ?? null;
      let query = supabaseAdmin
        .from("support_messages" as never)
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", conversationId)
        .eq("sender_type", "customer");
      if (lastRead) query = query.gt("created_at", lastRead);
      const [{ count }, { data: lastCustomer }] = await Promise.all([
        query,
        supabaseAdmin
          .from("support_messages" as never)
          .select("created_at")
          .eq("conversation_id", conversationId)
          .eq("sender_type", "customer")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      unreadCounts.set(conversationId, count ?? 0);
      lastCustomerAt.set(
        conversationId,
        (lastCustomer as { created_at: string } | null)?.created_at ?? null,
      );
    }),
  );

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    location_id: row.location_id,
    location_name: row.location_id ? (locationNames.get(row.location_id) ?? null) : null,
    customer_name: row.customer_id ? (customerNames.get(row.customer_id) ?? null) : null,
    customer_avatar_url: row.customer_id ? (customerAvatars.get(row.customer_id) ?? null) : null,
    last_message: row.last_message_preview,
    updated_at: row.updated_at,
    last_customer_message_at: lastCustomerAt.get(row.id) ?? null,
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
  queue?: SupportQueue | null;
  limit?: number;
  cursor?: string | null;
  location_id?: string | null;
  /** 已清洗的搜索词（客户昵称/手机号片段、商品标题/编码、订单号），在数据库分页前过滤 */
  q?: string | null;
}): Promise<{ items: SupportConversationSummary[]; next_cursor: string | null; queue: SupportQueue }> {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const queue: SupportQueue = input.queue ?? "all";
  const cursor = decodeSupportCursor(input.cursor);
  if (cursor === "invalid") throw new Error("invalid_cursor");
  if (!input.access.is_hq_agent && input.access.location_ids.length === 0) {
    return { items: [], next_cursor: null, queue };
  }
  // 所有筛选（门店范围 + 队列 + 游标）都在 limit 之前由数据库执行
  let query = supabaseAdmin
    .from("support_conversations" as never)
    .select(CONVERSATION_COLUMNS)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (!input.access.is_hq_agent) query = query.in("location_id", input.access.location_ids);
  if (input.location_id) query = query.eq("location_id", input.location_id);
  if (input.status) query = query.eq("status", input.status);
  if (queue === "unclaimed") query = query.in("status", ["open", "pending"]).is("primary_agent_id", null);
  else if (queue === "mine")
    query = query.in("status", ["open", "pending"]).eq("primary_agent_id", input.access.user_id);
  else if (queue === "escalated")
    query = query.in("status", ["open", "pending"]).not("escalated_at", "is", null);
  else if (queue === "closed") query = query.eq("status", "closed");
  if (input.q) {
    const like = `*${input.q}*`;
    const digits = /^\d{4,}$/.test(input.q);
    // 先按搜索词解析出客户/订单编号（各最多 200），再与门店范围、队列、游标一起交给数据库过滤后分页
    const [{ data: custRows, error: custErr }, { data: orderRows, error: orderErr }] = await Promise.all([
      supabaseAdmin
        .from("commerce_customers" as never)
        .select("id")
        .or(digits ? `nickname.ilike.${like},phone.ilike.${like}` : `nickname.ilike.${like}`)
        .limit(200),
      supabaseAdmin.from("commerce_orders" as never).select("id").ilike("order_no", like).limit(200),
    ]);
    if (custErr) throw new Error(custErr.message);
    if (orderErr) throw new Error(orderErr.message);
    const custIds = ((custRows as { id: string }[] | null) ?? []).map((r) => r.id);
    const orderIds = ((orderRows as { id: string }[] | null) ?? []).map((r) => r.id);
    const parts = [
      `title.ilike.${like}`,
      `context->>title.ilike.${like}`,
      `context->>order_no.ilike.${like}`,
      `context->>sku_code.ilike.${like}`,
    ];
    if (custIds.length) parts.push(`customer_id.in.(${custIds.join(",")})`);
    if (orderIds.length) parts.push(`order_id.in.(${orderIds.join(",")})`);
    query = query.or(parts.join(","));
  }
  if (cursor) {
    query = query.or(
      `updated_at.lt."${cursor.updated_at}",and(updated_at.eq."${cursor.updated_at}",id.lt.${cursor.id})`,
    );
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data as unknown as ConversationRow[]) ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    items: await hydrate(page, input.access),
    next_cursor: hasMore && last ? encodeSupportCursor(last) : null,
    queue,
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

type MessageRow = Omit<SupportMessage, keyof SupportSenderPresentation> & {
  sender_user_id: string | null;
  sender_customer_id: string | null;
};

/** Caller must have authorized this exact conversation before invoking any avatar lookup. */
async function presentMessages(
  conversation: ConversationRow,
  rows: MessageRow[],
  staffView: boolean,
  viewerUserId: string | null = null,
): Promise<SupportMessage[]> {
  if (!rows.length) return [];
  const staffIds = [...new Set(rows.filter((r) => r.sender_type === "staff" && r.sender_user_id)
    .map((r) => r.sender_user_id).filter((id): id is string => !!id))];
  const [{ data: customer }, { data: location }, { data: participants }] = await Promise.all([
    conversation.customer_id && rows.some((r) => r.sender_type === "customer" && r.sender_customer_id === conversation.customer_id)
      ? supabaseAdmin.from("commerce_customers").select("avatar_url").eq("id", conversation.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    conversation.location_id && staffIds.length
      ? supabaseAdmin.from("inv_locations").select("name,shop_id").eq("id", conversation.location_id).maybeSingle()
      : Promise.resolve({ data: null }),
    staffIds.length
      ? supabaseAdmin.from("support_participants" as never).select("user_id,participant_role")
        .eq("conversation_id", conversation.id).in("user_id", staffIds)
      : Promise.resolve({ data: [] }),
  ]);
  const roles = new Map(((participants as { user_id: string; participant_role: string }[] | null) ?? [])
    .map((p) => [p.user_id, p.participant_role]));
  // Existing shop image_url can be a private object key; never sign it or return the key.
  const shopId = location?.shop_id;
  const { data: shop } = shopId && [...roles.values()].includes("store_staff")
    ? await supabaseAdmin.from("youzan_shops").select("image_url").eq("id", shopId).maybeSingle()
    : { data: null };
  const hqAvatars = new Map<string, string | null>();
  await Promise.all(staffIds.filter((id) => roles.get(id) === "hq_agent").map(async (id) => {
    hqAvatars.set(id, (await loadStaffProfile(id)).hq_avatar_url);
  }));
  return rows.map((r) => {
    const presentation = senderPresentation({
      sender_type: r.sender_type, sender_customer_id: r.sender_customer_id,
      conversation_customer_id: conversation.customer_id,
      participant_role: r.sender_user_id ? roles.get(r.sender_user_id) : null,
      customer_avatar_url: customer?.avatar_url, store_avatar_url: shop?.image_url,
      hq_avatar_url: r.sender_user_id ? hqAvatars.get(r.sender_user_id) : null,
      location_name: location?.name,
    });
    return {
      id: r.id, sender_type: r.sender_type,
      // Historical sender_name can contain an email/UUID: customer responses use safe role labels.
      sender_name: staffView || r.sender_type === "customer" ? r.sender_name
        : presentation.sender_role === "hq_agent" ? "总部客服"
        : presentation.sender_role === "store_staff" ? `${presentation.sender_location_name ?? "门店"}客服` : "系统",
      body: r.body, internal: r.internal, delivery_status: r.delivery_status ?? "sent", created_at: r.created_at,
      ...presentation,
      // is_mine 只在员工端返回；顾客端永不暴露 sender_user_id 或其派生字段
      ...(staffView ? { is_mine: !!viewerUserId && r.sender_user_id === viewerUserId } : {}),
    };
  });
}

async function loadMessages(
  conversation: ConversationRow,
  includeInternal: boolean,
  window: MessageWindow = { mode: "latest", limit: MESSAGE_WINDOW, legacy: true },
  viewerUserId: string | null = null,
): Promise<{
  messages: SupportMessage[];
  has_more: boolean;
  has_newer: boolean;
  older_cursor: string | null;
  latest_cursor: string | null;
}> {
  const asc = window.mode === "after";
  let query = supabaseAdmin
    .from("support_messages" as never)
    .select("id, sender_name, sender_type, sender_user_id, sender_customer_id, body, internal, delivery_status, created_at")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: asc })
    .order("id", { ascending: asc })
    .limit(window.limit + 1);
  if (!includeInternal) query = query.eq("internal", false).eq("delivery_status", "sent");
  if (window.mode !== "latest") query = query.or(cursorFilter(window.mode, window.cursor));
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const shaped = shapeMessageWindow(window, (data as unknown as MessageRow[]) ?? []);
  const messages = await presentMessages(conversation, shaped.rows, includeInternal, viewerUserId);
  return {
    messages,
    has_more: shaped.has_more,
    has_newer: shaped.has_newer,
    older_cursor: shaped.older_cursor,
    latest_cursor: shaped.latest_cursor,
  };
}

const MESSAGE_WINDOW = 500;

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

/** 授权：会话存在 → 员工有权 → 可选 location_id 必须等于会话门店（HQ 也不例外）。 */
async function authorizeStaffConversation(
  access: SupportAccess,
  conversationId: string,
  locationId?: string | null,
): Promise<{ ok: true; conversation: ConversationRow } | { ok: false; code: string }> {
  const conversation = await loadConversationRow(conversationId);
  if (!conversation) return { ok: false, code: "not_found" };
  if (!staffCanAccessConversation(access, conversation)) return { ok: false, code: "forbidden" };
  const loc = assertConversationLocation(conversation.location_id, locationId);
  if (!loc.ok) return { ok: false, code: loc.code };
  return { ok: true, conversation };
}

export async function getStaffConversation(
  access: SupportAccess,
  conversationId: string,
  opts: { locationId?: string | null; window?: MessageWindow } = {},
) {
  const auth = await authorizeStaffConversation(access, conversationId, opts.locationId);
  if (!auth.ok) return { ok: false as const, code: auth.code };
  const conversation = auth.conversation;
  // 授权之后：已读写入、会话摘要、消息窗口互不依赖 → 并行，已读不再拖慢正文返回
  const [, [summary], window] = await Promise.all([
    joinConversation(access, conversationId),
    hydrate([conversation], access),
    loadMessages(conversation, true, opts.window, access.user_id),
  ]);
  return {
    ok: true as const,
    data: {
      conversation: { ...summary, order_id: conversation.order_id, topic: conversation.topic },
      ...window,
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

function pickMessage(m: Record<string, unknown> | undefined): MessageRow | null {
  if (!m) return null;
  return {
    id: String(m.id),
    sender_name: String(m.sender_name),
    sender_type: m.sender_type as SupportMessage["sender_type"],
    sender_user_id: typeof m.sender_user_id === "string" ? m.sender_user_id : null,
    sender_customer_id: typeof m.sender_customer_id === "string" ? m.sender_customer_id : null,
    body: String(m.body),
    internal: Boolean(m.internal),
    delivery_status: (m.delivery_status as SupportMessage["delivery_status"]) ?? "sent",
    created_at: String(m.created_at),
  };
}

/**
 * 员工发消息：对外回复必须是主接待人且带当前 assignment_version；内部备注任何授权协作者可写。
 * 授权、版本、幂等、insert 在数据库同一事务内完成（support_staff_post_message）。
 * wechat_kf 渠道未接通，RPC 拒绝外发；历史 pending 不补发。
 */
export async function postStaffMessage(input: {
  access: SupportAccess;
  conversationId: string;
  body: string;
  internal: boolean;
  clientOpId: string;
  assignmentVersion?: number | null;
  locationId?: string | null;
}) {
  const auth = await authorizeStaffConversation(input.access, input.conversationId, input.locationId);
  if (!auth.ok) return { ok: false as const, code: auth.code };
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
  // Re-authorize after the transaction before reading presentation sources.
  const fresh = await loadConversationRow(input.conversationId);
  if (!fresh || !staffCanAccessConversation(input.access, fresh)) return { ok: false as const, code: "forbidden" };
  const message = pickMessage(r.message);
  const presented = message ? await presentMessages(fresh, [message], true, input.access.user_id) : [];
  return { ok: true as const, data: { message: presented[0] ?? null, replayed: Boolean(r.replayed) } };
}

export async function updateConversationAssignment(input: {
  access: SupportAccess;
  conversationId: string;
  action: SupportAssignmentAction;
  assignmentVersion: number | null;
  locationId?: string | null;
}) {
  if (input.locationId?.trim()) {
    // 提供了门店时先在写入前核对，错误库位不能写
    const auth = await authorizeStaffConversation(input.access, input.conversationId, input.locationId);
    if (!auth.ok) return { ok: false as const, code: auth.code, detail: {} };
  }
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
  const fresh = await getStaffConversation(input.access, input.conversationId, {
    locationId: input.locationId,
    window: { mode: "latest", limit: 1, legacy: false },
  });
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
       ...(await loadMessages(conversation, false)),
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
  const conversation = await loadConversationRow(input.conversationId);
  if (!conversation || conversation.customer_id !== input.customerId) return { ok: false as const, code: "not_found" };
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
  const fresh = await loadConversationRow(input.conversationId);
  if (!fresh || fresh.customer_id !== input.customerId) return { ok: false as const, code: "not_found" };
  const message = pickMessage(r.message);
  const presented = message && !message.internal && message.delivery_status === "sent"
    ? await presentMessages(fresh, [message], false) : [];
  return { ok: true as const, data: { message: presented[0] ?? null, replayed: Boolean(r.replayed) } };
}
