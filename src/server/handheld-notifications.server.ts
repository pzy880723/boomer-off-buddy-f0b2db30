// 统一消息中心：设备 + 员工双重鉴权后的可见范围、分页与按人已读。
// 可见范围 = 定向给本人 OR 定向给本设备 OR 本人有权限的库位 OR 全局广播。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadUserRoles } from "@/server/handheld-auth.server";
import { parseListCursor } from "@/server/handheld-notifications-cursor";
import { alertFields } from "@/server/handheld-alerts";
import {
  notificationKindCategory,
  type NotificationCategory,
} from "@/lib/handheld/notification-category";
export { parseChangeCursor, parseListCursor } from "@/server/handheld-notifications-cursor";

export type NotificationItem = {
  id: string;
  kind: string;
  title: string | null;
  payload: Record<string, unknown>;
  ts: string;
  is_read: boolean;
  action_status: string | null;
  location_id: string | null;
  location_name: string | null;
  ref_type: string | null;
  ref_id: string | null;
  /** 原生提醒：未读且未处理的 order_paid / measurement_requested 才为 true。 */
  should_alert: boolean;
  alert_kind: "order_paid" | "measurement_requested" | null;
  measurement_task_id: string | null;
  sku_id: string | null;
};

export type NotificationScope = {
  user_id: string;
  device_id: string;
  device_location_id: string | null;
  location_ids: string[];
  is_hq: boolean;
  /** 显式当前门店（已校验授权）；设置后所有查询只看该店 + 本人/本设备/全局。 */
  filter_location_id?: string | null;
};

/** 查询实际使用的门店集合：显式门店优先，否则账号全部授权门店。 */
export function effectiveLocationIds(scope: NotificationScope): string[] {
  return scope.filter_location_id ? [scope.filter_location_id] : scope.location_ids;
}

/**
 * 校验显式 location_id：必须是 UUID 且在账号授权范围内（总部=全部启用门店）。
 * 未传返回原 scope（兼容旧客户端）。普通员工无法借参数扩大范围。
 */
export function applyRequestedLocation(
  scope: NotificationScope,
  raw: string | null | undefined,
): { ok: true; scope: NotificationScope } | { ok: false; code: "validation_error" | "location_forbidden" } {
  const v = (raw ?? "").trim();
  if (!v) return { ok: true, scope };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return { ok: false, code: "validation_error" };
  if (!scope.location_ids.includes(v.toLowerCase()) && !scope.location_ids.includes(v)) return { ok: false, code: "location_forbidden" };
  return { ok: true, scope: { ...scope, filter_location_id: scope.location_ids.includes(v) ? v : v.toLowerCase() } };
}

type RawRow = {
  id: string;
  kind: string;
  title: string | null;
  payload: Record<string, unknown> | null;
  ts: string;
  device_id: string | null;
  location_id: string | null;
  user_id: string | null;
  action_status: string | null;
  ref_type: string | null;
  ref_id: string | null;
};

export async function resolveNotificationScope(input: {
  userId: string;
  deviceId: string;
  deviceLocationId: string | null;
}): Promise<NotificationScope> {
  const roles = await loadUserRoles(input.userId);
  const isHq = roles.includes("super_admin") || roles.includes("hq_operator");
  let locationIds: string[] = [];
  if (isHq) {
    const { data } = await supabaseAdmin.from("inv_locations").select("id").eq("is_active", true);
    locationIds = ((data as { id: string }[] | null) ?? []).map((row) => row.id);
  } else {
    const { data } = await supabaseAdmin
      .from("user_location_perms" as never)
      .select("location_id")
      .eq("user_id", input.userId);
    locationIds = ((data as { location_id: string }[] | null) ?? []).map((row) => row.location_id);
  }
  // 设备当前绑定库位必须也在授权范围内才生效（撤权后立即失效）。
  return {
    user_id: input.userId,
    device_id: input.deviceId,
    device_location_id:
      input.deviceLocationId && locationIds.includes(input.deviceLocationId)
        ? input.deviceLocationId
        : null,
    location_ids: locationIds,
    is_hq: isHq,
  };
}

/**
 * PostgREST 的 or() 过滤串（只在查询层过滤，不在内存里裁剪整页）。与 DB handheld_notifications_changes 同一规则：
 * 门店为空或在有效门店内；且 定向本人 OR (未定向用户 且 设备为空或为本设备)。
 * 同店但定向给其他员工/设备的通知不可见。
 */
export function buildVisibilityFilter(scope: NotificationScope): string {
  const locs = effectiveLocationIds(scope);
  const loc = locs.length > 0 ? `location_id.is.null,location_id.in.(${locs.join(",")})` : "location_id.is.null";
  const who = `user_id.eq.${scope.user_id},and(user_id.is.null,device_id.is.null),and(user_id.is.null,device_id.eq.${scope.device_id})`;
  return `and(or(${loc}),or(${who}))`;
}

async function decorate(rows: RawRow[], scope: NotificationScope): Promise<NotificationItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [{ data: reads }, { data: locations }] = await Promise.all([
    supabaseAdmin
      .from("handheld_notification_reads" as never)
      .select("notification_id")
      .eq("user_id", scope.user_id)
      .in("notification_id", ids),
    supabaseAdmin
      .from("inv_locations")
      .select("id,name")
      .in("id", [...new Set(rows.map((row) => row.location_id).filter(Boolean))] as string[]),
  ]);
  const readSet = new Set(
    ((reads as { notification_id: string }[] | null) ?? []).map((row) => row.notification_id),
  );
  const locationNames = new Map(
    ((locations as { id: string; name: string }[] | null) ?? []).map((row) => [row.id, row.name]),
  );
  return rows.map((row) => {
    const item = {
      id: row.id,
      kind: row.kind,
      title: row.title ?? null,
      payload: row.payload ?? {},
      ts: row.ts,
      is_read: readSet.has(row.id),
      action_status: row.action_status ?? null,
      location_id: row.location_id ?? null,
      location_name: row.location_id ? (locationNames.get(row.location_id) ?? null) : null,
      ref_type: row.ref_type ?? null,
      ref_id: row.ref_id ?? null,
    };
    return { ...item, ...alertFields(item) };
  });
}

const SELECT =
  "id, kind, title, payload, ts, device_id, location_id, user_id, action_status, ref_type, ref_id";

// category 服务端过滤：先取全库 kind 枚举，用与 DB 同规则的 TS 端口归类，
// 匹配的 kind 集合作为 .in 过滤条件（在 limit 之前生效）；未知 kind 归 system。
async function resolveCategoryKinds(category: NotificationCategory): Promise<string[]> {
  const { data, error } = await supabaseAdmin.rpc("handheld_notification_kinds" as never);
  if (error) throw new Error(error.message);
  const kinds = (data as unknown as string[]) ?? [];
  return kinds.filter((k) => notificationKindCategory(k) === category);
}

export async function listNotifications(input: {
  scope: NotificationScope;
  limit: number;
  cursor?: string | null;
  unreadOnly?: boolean;
  category?: NotificationCategory;
}): Promise<{ items: NotificationItem[]; next_cursor: string | null; next_page_cursor: string | null }> {
  let query = supabaseAdmin
    .from("inv_handheld_notifications" as never)
    .select(SELECT)
    .or(buildVisibilityFilter(input.scope))
    .order("ts", { ascending: false })
    .limit(input.limit + 1);
  if (input.category) {
    const kinds = await resolveCategoryKinds(input.category);
    if (kinds.length === 0) return { items: [], next_cursor: null, next_page_cursor: null };
    query = query.in("kind", kinds);
  }
  // 兼容：旧游标=纯 ts（保持原 lt 语义）；新游标 "ts|id" 走 (ts,id) 复合键，同 ts 不漏行。
  const composite = input.cursor ? parseListCursor(input.cursor) : null;
  query = query.order("id", { ascending: false });
  if (composite) {
    query = query.or(`ts.lt.${composite.ts},and(ts.eq.${composite.ts},id.lt.${composite.id})`);
  } else if (input.cursor) {
    query = query.lt("ts", input.cursor);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = ((data as unknown as RawRow[]) ?? []).slice();
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  let items = await decorate(page, input.scope);
  if (input.unreadOnly) items = items.filter((item) => !item.is_read);
  const last = page[page.length - 1];
  return {
    items,
    next_cursor: hasMore ? (last?.ts ?? null) : null,
    next_page_cursor: hasMore && last ? `${last.ts}|${last.id}` : null,
  };
}

export async function listNotificationsSince(input: {
  scope: NotificationScope;
  since?: string | null;
  limit: number;
}): Promise<{ items: NotificationItem[]; server_ts: string }> {
  let query = supabaseAdmin
    .from("inv_handheld_notifications" as never)
    .select(SELECT)
    .or(buildVisibilityFilter(input.scope))
    .order("ts", { ascending: true })
    .limit(input.limit);
  if (input.since) query = query.gt("ts", input.since);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data as unknown as RawRow[]) ?? [];
  const items = await decorate(rows, input.scope);
  const serverTs =
    items.length > 0 ? items[items.length - 1].ts : (input.since ?? new Date().toISOString());
  return { items, server_ts: serverTs };
}

/**
 * 可靠增量：返回 (change_xid, change_seq) 大于游标、且所有更早事务均已结束的变更。
 * 同一消息的 handled/voided/已读 变化会以最新状态再次下发；客户端按 id upsert，
 * 只在首次见到 action_status=null 且未读的 order_paid 时播报。
 */
export async function listNotificationChanges(input: {
  scope: NotificationScope;
  cursor: { xid: string; seq: number } | "latest";
  limit: number;
}): Promise<{ items: (NotificationItem & { change_cursor: string })[]; next_cursor: string; has_more: boolean; server_ts: string }> {
  // 持久补偿：每次增量拉取先尽力补写近 7 天缺失的付款提醒（唯一索引防重；失败不影响读取）。
  try {
    await supabaseAdmin.rpc("handheld_notify_reconcile" as never, { p_days: 7, p_limit: 50 } as never);
  } catch {
    /* best effort */
  }
  const serverTs = new Date().toISOString();
  if (input.cursor === "latest") {
    const { data, error } = await supabaseAdmin.rpc("handheld_notifications_watermark" as never);
    if (error) throw new Error(error.message);
    return { items: [], next_cursor: `v2:${data as unknown as string}:0`, has_more: false, server_ts: serverTs };
  }
  const { data, error } = await supabaseAdmin.rpc("handheld_notifications_changes" as never, {
    p_user_id: input.scope.user_id,
    p_device_id: input.scope.device_id,
    p_location_ids: effectiveLocationIds(input.scope),
    p_after_xid: input.cursor.xid,
    p_after_seq: input.cursor.seq,
    p_limit: input.limit,
  } as never);
  if (error) throw new Error(error.message);
  const rows = (data as unknown as (RawRow & { change_xid: string; change_seq: number })[]) ?? [];
  const items = await decorate(rows, input.scope);
  const withCursor = items.map((item, i) => ({ ...item, change_cursor: `v2:${rows[i].change_xid}:${rows[i].change_seq}` }));
  const last = rows[rows.length - 1];
  return {
    items: withCursor,
    next_cursor: last ? `v2:${last.change_xid}:${last.change_seq}` : `v2:${input.cursor.xid}:${input.cursor.seq}`,
    has_more: rows.length >= input.limit,
    server_ts: serverTs,
  };
}

export async function countUnread(scope: NotificationScope): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("inv_handheld_notifications" as never)
    .select("id")
    .or(buildVisibilityFilter(scope))
    .order("ts", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  const ids = ((data as { id: string }[] | null) ?? []).map((row) => row.id);
  if (ids.length === 0) return 0;
  const { data: reads } = await supabaseAdmin
    .from("handheld_notification_reads" as never)
    .select("notification_id")
    .eq("user_id", scope.user_id)
    .in("notification_id", ids);
  const read = new Set(
    ((reads as { notification_id: string }[] | null) ?? []).map((row) => row.notification_id),
  );
  return ids.filter((id) => !read.has(id)).length;
}

/** 单条已读：幂等，只影响当前用户，且必须在其可见范围内。 */
export async function markNotificationRead(
  scope: NotificationScope,
  notificationId: string,
): Promise<{ notification_id: string; is_read: true; read_at: string } | null> {
  const { data } = await supabaseAdmin
    .from("inv_handheld_notifications" as never)
    .select("id")
    .eq("id", notificationId)
    .or(buildVisibilityFilter(scope))
    .maybeSingle();
  if (!data) return null;
  const readAt = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("handheld_notification_reads" as never)
    .upsert({ notification_id: notificationId, user_id: scope.user_id, read_at: readAt } as never, {
      onConflict: "notification_id,user_id",
      ignoreDuplicates: true,
    });
  if (error) throw new Error(error.message);
  const { data: existing } = await supabaseAdmin
    .from("handheld_notification_reads" as never)
    .select("read_at")
    .eq("notification_id", notificationId)
    .eq("user_id", scope.user_id)
    .maybeSingle();
  return {
    notification_id: notificationId,
    is_read: true,
    read_at: ((existing as { read_at?: string } | null)?.read_at ?? readAt) as string,
  };
}

/** 全部已读：真正落库，scope 明确为「当前可见范围内、截止调用时刻」的消息。 */
export async function markAllNotificationsRead(
  scope: NotificationScope,
): Promise<{ marked: number; scope: string; up_to: string }> {
  const upTo = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("inv_handheld_notifications" as never)
    .select("id")
    .or(buildVisibilityFilter(scope))
    .lte("ts", upTo)
    .order("ts", { ascending: false })
    .limit(1000);
  if (error) throw new Error(error.message);
  const ids = ((data as { id: string }[] | null) ?? []).map((row) => row.id);
  if (ids.length === 0) return { marked: 0, scope: describeScope(scope), up_to: upTo };
  const { error: insertError } = await supabaseAdmin
    .from("handheld_notification_reads" as never)
    .upsert(
      ids.map((id) => ({ notification_id: id, user_id: scope.user_id, read_at: upTo })) as never,
      { onConflict: "notification_id,user_id", ignoreDuplicates: true },
    );
  if (insertError) throw new Error(insertError.message);
  return { marked: ids.length, scope: describeScope(scope), up_to: upTo };
}

export function describeScope(scope: NotificationScope): string {
  if (scope.filter_location_id) return scope.is_hq ? "hq_single_location" : "single_location";
  if (scope.is_hq) return "hq_all_locations";
  return scope.location_ids.length > 0 ? `locations:${scope.location_ids.length}` : "personal_only";
}
