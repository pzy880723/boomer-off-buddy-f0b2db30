// 客服会话：门店员工与总部客服共享同一会话，无独占领取。
// 授权口径：super_admin / hq_operator / support_agents(scope='hq') → 全部会话；
// 其余员工按 user_location_perms + support_agents(scope='location') 覆盖的 location_id。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadUserRoles } from "@/server/handheld-auth.server";

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
};

export type SupportMessage = {
  id: string;
  sender_name: string;
  sender_type: "customer" | "staff" | "system";
  body: string;
  internal: boolean;
  created_at: string;
};

const nameCache = new Map<string, string>();

export async function resolveUserDisplayName(userId: string): Promise<string> {
  const cached = nameCache.get(userId);
  if (cached) return cached;
  const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
  const meta = (data?.user?.user_metadata ?? {}) as { name?: string; full_name?: string };
  const name =
    meta.name || meta.full_name || data?.user?.email?.split("@")[0] || userId.slice(-6);
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
    ((agents as { scope: string; location_id: string | null; display_name: string | null }[] | null) ??
      []);
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
        ...agentRows.map((row) => row.location_id).filter(Boolean as unknown as (v: unknown) => v is string),
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
    ((customers as { id: string; nickname: string | null; phone?: string | null }[] | null) ?? []).map(
      (r) => [r.id, r.nickname || (r.phone ? `${r.phone.slice(0, 3)}****${r.phone.slice(-2)}` : "顾客")],
    ),
  );
  const lastReads = new Map(
    ((myRows as { conversation_id: string; last_read_at: string | null }[] | null) ?? []).map((r) => [
      r.conversation_id,
      r.last_read_at,
    ]),
  );
  const participantRows =
    ((participants as
      | { conversation_id: string; user_id: string; participant_role: string; display_name: string | null }[]
      | null) ?? []);
  const participantNames = new Map<string, string>();
  await Promise.all(
    [...new Set(participantRows.map((r) => r.user_id))].map(async (userId) => {
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
  }));
}

export async function listStaffConversations(input: {
  access: SupportAccess;
  status?: string | null;
  limit?: number;
  cursor?: string | null;
}): Promise<{ items: SupportConversationSummary[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  if (!input.access.is_hq_agent && input.access.location_ids.length === 0) {
    return { items: [], next_cursor: null };
  }
  let query = supabaseAdmin
    .from("support_conversations" as never)
    .select(
      "id,title,location_id,customer_id,order_id,status,topic,last_message_at,last_message_preview,created_at,updated_at",
    )
    .order("updated_at", { ascending: false })
    .limit(limit + 1);
  if (!input.access.is_hq_agent) query = query.in("location_id", input.access.location_ids);
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
    .select(
      "id,title,location_id,customer_id,order_id,status,topic,last_message_at,last_message_preview,created_at,updated_at",
    )
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
    .select("id, sender_name, sender_type, body, internal, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(500);
  if (!includeInternal) query = query.eq("internal", false);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data as unknown as SupportMessage[]) ?? []).map((row) => ({
    id: row.id,
    sender_name: row.sender_name,
    sender_type: row.sender_type,
    body: row.body,
    internal: row.internal,
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
      can_reply: conversation.status !== "closed",
    },
  };
}

export async function postStaffMessage(input: {
  access: SupportAccess;
  conversationId: string;
  body: string;
  internal: boolean;
  clientOpId: string;
}) {
  const conversation = await loadConversationRow(input.conversationId);
  if (!conversation) return { ok: false as const, code: "not_found" };
  if (!staffCanAccessConversation(input.access, conversation)) {
    return { ok: false as const, code: "forbidden" };
  }
  if (conversation.status === "closed") return { ok: false as const, code: "conversation_closed" };

  const existing = await supabaseAdmin
    .from("support_messages" as never)
    .select("id, sender_name, sender_type, body, internal, created_at")
    .eq("conversation_id", input.conversationId)
    .eq("client_op_id", input.clientOpId)
    .maybeSingle();
  if (existing.data) {
    return { ok: true as const, data: { message: existing.data, replayed: true } };
  }

  await joinConversation(input.access, input.conversationId);
  const { data, error } = await supabaseAdmin
    .from("support_messages" as never)
    .insert({
      conversation_id: input.conversationId,
      sender_type: "staff",
      sender_user_id: input.access.user_id,
      sender_name: input.access.display_name,
      body: input.body,
      internal: input.internal,
      client_op_id: input.clientOpId,
    } as never)
    .select("id, sender_name, sender_type, body, internal, created_at")
    .single();
  if (error) {
    if (/duplicate key/i.test(error.message)) {
      const retry = await supabaseAdmin
        .from("support_messages" as never)
        .select("id, sender_name, sender_type, body, internal, created_at")
        .eq("conversation_id", input.conversationId)
        .eq("client_op_id", input.clientOpId)
        .maybeSingle();
      if (retry.data) return { ok: true as const, data: { message: retry.data, replayed: true } };
    }
    throw new Error(error.message);
  }
  return { ok: true as const, data: { message: data, replayed: false } };
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

export async function ensureCustomerConversation(input: {
  customerId: string;
  customerName: string;
  locationId?: string | null;
  orderId?: string | null;
  title?: string | null;
  topic?: string;
}) {
  const existing = await supabaseAdmin
    .from("support_conversations" as never)
    .select("id")
    .eq("customer_id", input.customerId)
    .eq("status", "open")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.data) return (existing.data as { id: string }).id;
  const { data, error } = await supabaseAdmin
    .from("support_conversations" as never)
    .insert({
      customer_id: input.customerId,
      location_id: input.locationId ?? null,
      order_id: input.orderId ?? null,
      title: input.title ?? `${input.customerName} 的咨询`,
      topic: input.topic ?? "general",
    } as never)
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
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
        updated_at: conversation.updated_at,
      },
      // 客户永远看不到内部备注
      messages: await loadMessages(conversationId, false),
      can_reply: conversation.status !== "closed",
    },
  };
}

export async function postCustomerMessage(input: {
  customerId: string;
  customerName: string;
  conversationId: string;
  body: string;
  clientOpId: string;
}) {
  const conversation = await loadConversationRow(input.conversationId);
  if (!conversation || conversation.customer_id !== input.customerId) {
    return { ok: false as const, code: "not_found" };
  }
  if (conversation.status === "closed") return { ok: false as const, code: "conversation_closed" };
  const existing = await supabaseAdmin
    .from("support_messages" as never)
    .select("id, sender_name, sender_type, body, internal, created_at")
    .eq("conversation_id", input.conversationId)
    .eq("client_op_id", input.clientOpId)
    .maybeSingle();
  if (existing.data) return { ok: true as const, data: { message: existing.data, replayed: true } };

  const { data, error } = await supabaseAdmin
    .from("support_messages" as never)
    .insert({
      conversation_id: input.conversationId,
      sender_type: "customer",
      sender_customer_id: input.customerId,
      sender_name: input.customerName,
      body: input.body,
      internal: false,
      client_op_id: input.clientOpId,
    } as never)
    .select("id, sender_name, sender_type, body, internal, created_at")
    .single();
  if (error) throw new Error(error.message);
  return { ok: true as const, data: { message: data, replayed: false } };
}
