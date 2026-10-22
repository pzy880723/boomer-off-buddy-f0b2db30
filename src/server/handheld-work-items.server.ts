import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveNotificationScope, type NotificationScope } from "./handheld-notifications.server";
import { resolveSupportAccess } from "./support.server";
import { decodeWorkCursor, parseWorkCounts, type WorkItem } from "@/lib/handheld/work-items";
import { loadSupportMeasurementCards, measurementThumbnails } from "./support-measurement.server";

export type WorkScope = NotificationScope & {
  support_location_ids: string[];
  support_include_unlocated: boolean;
};

/** Customer-service grants must never expand order/inventory/internal-business grants. */
export async function resolveWorkScope(input: {
  userId: string;
  deviceId?: string;
  deviceLocationId?: string | null;
}): Promise<WorkScope> {
  const [general, support] = await Promise.all([
    resolveNotificationScope({
      userId: input.userId,
      deviceId: input.deviceId ?? "",
      deviceLocationId: input.deviceLocationId ?? null,
    }),
    resolveSupportAccess(input.userId),
  ]);
  let supportLocations = support.location_ids;
  if (support.is_hq_agent) {
    const { data, error } = await supabaseAdmin.from("inv_locations").select("id");
    if (error) throw new Error("work_scope_unavailable");
    supportLocations = (data ?? []).map((location) => location.id);
  }
  return {
    ...general,
    support_location_ids: [...new Set(supportLocations)],
    support_include_unlocated: support.is_hq_agent,
  };
}

export function applyWorkLocation(
  scope: WorkScope,
  raw: string | null | undefined,
): { ok: true; scope: WorkScope } | { ok: false; code: "validation_error" | "location_forbidden" } {
  const wanted = raw?.trim().toLowerCase();
  if (!wanted) return { ok: true, scope };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(wanted))
    return { ok: false, code: "validation_error" };
  if (![...scope.location_ids, ...scope.support_location_ids].includes(wanted))
    return { ok: false, code: "location_forbidden" };
  return { ok: true, scope: { ...scope, filter_location_id: wanted } };
}

export function generalWorkLocationIds(scope: WorkScope) {
  return scope.filter_location_id
    ? scope.location_ids.filter((id) => id === scope.filter_location_id)
    : scope.location_ids;
}
function supportWorkLocationIds(scope: WorkScope) {
  return scope.filter_location_id
    ? scope.support_location_ids.filter((id) => id === scope.filter_location_id)
    : scope.support_location_ids;
}
function scopeArgs(scope: WorkScope) {
  return {
    p_user_id: scope.user_id,
    p_location_ids: generalWorkLocationIds(scope),
    p_include_unlocated: scope.is_hq && !scope.filter_location_id,
    p_support_location_ids: supportWorkLocationIds(scope),
    p_support_include_unlocated: scope.support_include_unlocated && !scope.filter_location_id,
  };
}
function includesGeneralLocation(scope: WorkScope, id: string | null) {
  return id ? generalWorkLocationIds(scope).includes(id) : scope.is_hq && !scope.filter_location_id;
}
function includesSupportLocation(scope: WorkScope, id: string | null) {
  return id
    ? supportWorkLocationIds(scope).includes(id)
    : scope.support_include_unlocated && !scope.filter_location_id;
}
export async function loadPendingCounts(scope: WorkScope) {
  const { data, error } = await supabaseAdmin.rpc(
    "handheld_pending_counts_scoped" as never,
    scopeArgs(scope) as never,
  );
  if (error) throw new Error("pending_counts_unavailable");
  return parseWorkCounts(data);
}
type Conversation = { id: string; customer_id: string | null; location_id: string | null };
type Task = { id: string; sku_id: string; location_id: string | null; status: string };

/** SQL owns full counts/paging. Media hydration rechecks current scope; never emits raw refs. */
export async function loadWorkItems(
  scope: WorkScope,
  limit = 50,
  cursor?: string,
  opts?: { includeIgnored?: boolean; ignoredOnly?: boolean },
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_limit");
  const parsed = decodeWorkCursor(cursor);
  const { data, error } = await supabaseAdmin.rpc(
    "handheld_work_items_scoped" as never,
    {
      ...scopeArgs(scope),
      p_limit: limit,
      p_cursor_ts: parsed?.ts,
      p_cursor_id: parsed?.id,
      p_include_ignored: opts?.includeIgnored === true,
      p_ignored_only: opts?.ignoredOnly === true,
    } as never,
  );
  if (error || !data || typeof data !== "object" || Array.isArray(data))
    throw new Error("work_items_unavailable");
  const raw = data as {
    items: WorkItem[];
    counts: unknown;
    has_more: boolean;
    last_ts: string | null;
    last_id: string | null;
  };
  if (
    !Array.isArray(raw.items) ||
    typeof raw.has_more !== "boolean" ||
    raw.items.some(
      (r) =>
        !r ||
        [r.id, r.type, r.title, r.description, r.action, r.target_id].some(
          (v) => typeof v !== "string",
        ),
    )
  )
    throw new Error("work_items_contract_error");
  const counts = parseWorkCounts(raw.counts);
  let next_cursor: string | null = null;
  if (raw.has_more) {
    if (!raw.last_ts || !raw.last_id) throw new Error("work_items_cursor_contract_error");
    next_cursor = `${raw.last_ts}|${raw.last_id}`;
    // Preserve PostgreSQL microseconds: Date.toISOString() truncates a pagination key.
    decodeWorkCursor(next_cursor);
  }
  const imageByItem = new Map<string, string | null>();
  const conversationIds = [
    ...new Set(
      raw.items.filter((r) => r.conversation_id && r.sku_id).map((r) => r.conversation_id!),
    ),
  ];
  if (conversationIds.length) {
    const result = await supabaseAdmin
      .from("support_conversations" as never)
      .select("id,customer_id,location_id")
      .in("id", conversationIds);
    if (result.error) throw new Error("work_items_unavailable");
    const conversations = ((result.data ?? []) as Conversation[]).filter((c) =>
      includesSupportLocation(scope, c.location_id),
    );
    if (conversations.length) {
      const requests = await supabaseAdmin
        .from("product_measurement_requesters" as never)
        .select("task_id,customer_id,conversation_id")
        .in(
          "conversation_id",
          conversations.map((c) => c.id),
        );
      if (requests.error) throw new Error("work_items_unavailable");
      const links = (requests.data ?? []) as {
        task_id: string;
        customer_id: string;
        conversation_id: string;
      }[];
      await Promise.all(
        conversations.map(async (conversation) => {
          const messages = links
            .filter(
              (link) =>
                link.conversation_id === conversation.id &&
                link.customer_id === conversation.customer_id,
            )
            .map((link) => ({
              id: link.task_id,
              measurement_task_id: link.task_id,
              card_kind: "measurement_request",
            }));
          const cards = await loadSupportMeasurementCards(conversation, messages);
          for (const row of raw.items.filter((r) => r.conversation_id === conversation.id)) {
            imageByItem.set(
              row.id,
              [...cards.values()].find((card) => card.sku_id === row.sku_id)?.image_url ?? null,
            );
          }
        }),
      );
    }
  }
  const orphanRows = raw.items.filter(
    (r) => r.action === "measurement_task" && !r.conversation_id && r.sku_id,
  );
  if (orphanRows.length) {
    const result = await supabaseAdmin
      .from("product_measurement_tasks" as never)
      .select("id,sku_id,location_id,status")
      .in(
        "id",
        orphanRows.map((r) => r.target_id),
      );
    if (result.error) throw new Error("work_items_unavailable");
    const tasks = ((result.data ?? []) as Task[]).filter(
      (task) =>
        includesGeneralLocation(scope, task.location_id) &&
        ["pending", "claimed"].includes(task.status) &&
        orphanRows.some((r) => r.target_id === task.id && r.sku_id === task.sku_id),
    );
    if (tasks.length) {
      const skus = await supabaseAdmin
        .from("inv_skus")
        .select("id,image_paths,image_url")
        .in(
          "id",
          tasks.map((task) => task.sku_id),
        );
      if (skus.error) throw new Error("work_items_unavailable");
      const images = await measurementThumbnails(skus.data ?? []);
      for (const task of tasks) {
        const row = orphanRows.find((r) => r.target_id === task.id && r.sku_id === task.sku_id)!;
        imageByItem.set(row.id, images.get(task.sku_id) ?? null);
      }
    }
  }
  const items: WorkItem[] = raw.items.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    meta: null,
    urgency: "normal",
    action: row.action,
    target_id: row.target_id,
    sku_id: row.sku_id ?? null,
    conversation_id: row.conversation_id ?? null,
    image_url: imageByItem.get(row.id) ?? null,
    measurement_task_id: row.measurement_task_id ?? null,
    measurement_request_version: row.measurement_request_version ?? null,
    can_ignore: row.can_ignore === true,
    ignored: row.ignored === true,
    can_restore: row.can_restore === true,
  }));
  return { items, counts, next_cursor };
}
