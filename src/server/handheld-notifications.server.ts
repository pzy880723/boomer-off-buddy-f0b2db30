// 统一消息中心：设备 + 员工双重鉴权后的可见范围、分页与按人已读。
// 可见范围 = 定向给本人 OR 定向给本设备 OR 本人有权限的库位 OR 全局广播。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadUserRoles } from "@/server/handheld-auth.server";

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
};

export type NotificationScope = {
  user_id: string;
  device_id: string;
  device_location_id: string | null;
  location_ids: string[];
  is_hq: boolean;
};

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

/** PostgREST 的 or() 过滤串：只在查询层过滤，不在内存里裁剪整页。 */
export function buildVisibilityFilter(scope: NotificationScope): string {
  const clauses = [
    `user_id.eq.${scope.user_id}`,
    `device_id.eq.${scope.device_id}`,
    "and(user_id.is.null,device_id.is.null,location_id.is.null)",
  ];
  if (scope.location_ids.length > 0) {
    clauses.push(`location_id.in.(${scope.location_ids.join(",")})`);
  }
  return clauses.join(",");
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
      .in(
        "id",
        [...new Set(rows.map((row) => row.location_id).filter(Boolean))] as string[],
      ),
  ]);
  const readSet = new Set(
    ((reads as { notification_id: string }[] | null) ?? []).map((row) => row.notification_id),
  );
  const locationNames = new Map(
    ((locations as { id: string; name: string }[] | null) ?? []).map((row) => [row.id, row.name]),
  );
  return rows.map((row) => ({
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
  }));
}

const SELECT =
  "id, kind, title, payload, ts, device_id, location_id, user_id, action_status, ref_type, ref_id";

export async function listNotifications(input: {
  scope: NotificationScope;
  limit: number;
  cursor?: string | null;
  unreadOnly?: boolean;
}): Promise<{ items: NotificationItem[]; next_cursor: string | null }> {
  let query = supabaseAdmin
    .from("inv_handheld_notifications" as never)
    .select(SELECT)
    .or(buildVisibilityFilter(input.scope))
    .order("ts", { ascending: false })
    .limit(input.limit + 1);
  if (input.cursor) query = query.lt("ts", input.cursor);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = ((data as unknown as RawRow[]) ?? []).slice();
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  let items = await decorate(page, input.scope);
  if (input.unreadOnly) items = items.filter((item) => !item.is_read);
  return { items, next_cursor: hasMore ? (page[page.length - 1]?.ts ?? null) : null };
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
  if (scope.is_hq) return "hq_all_locations";
  return scope.location_ids.length > 0 ? `locations:${scope.location_ids.length}` : "personal_only";
}
