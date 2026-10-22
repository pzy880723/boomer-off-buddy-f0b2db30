var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// stub:client
var client_exports = {};
__export(client_exports, {
  supabaseAdmin: () => supabaseAdmin
});
var supabaseAdmin;
var init_client = __esm({
  "stub:client"() {
    supabaseAdmin = { rpc: async (name, args) => {
      const s = globalThis.__workItemsLocal;
      s.calls.push({ name, args });
      let items = s.items;
      if (s.autoFilter) items = items.filter((r) => r.fixture_category === "support" ? (args.p_support_location_ids ?? []).includes(r.fixture_location) : (args.p_location_ids ?? []).includes(r.fixture_location));
      return { error: null, data: name.includes("pending_counts") ? { "customers": 104, "internal": 2, "orders": 3, "system": 1, "total": 110 } : { items, counts: { "customers": 104, "internal": 2, "orders": 3, "system": 1, "total": 110 }, has_more: s.hasMore, last_ts: s.lastTs, last_id: s.lastId } };
    }, from(table) {
      const s = globalThis.__workItemsLocal;
      s.reads.push(table);
      const chain = { select: () => chain, eq: () => chain, in: () => chain, maybeSingle: () => chain, then(resolve) {
        const rows = { inv_locations: [{ id: "11111111-1111-4111-8111-111111111111" }, { id: "22222222-2222-4222-8222-222222222222" }], support_conversations: [{ id: "33333333-3333-4333-8333-333333333333", customer_id: "customer", location_id: s.store }], product_measurement_requesters: [{ task_id: "44444444-4444-4444-8444-444444444444", customer_id: "customer", conversation_id: "33333333-3333-4333-8333-333333333333" }], product_measurement_tasks: [{ id: "44444444-4444-4444-8444-444444444444", sku_id: "55555555-5555-4555-8555-555555555555", listing_id: null, location_id: s.taskStore, status: "pending" }], inv_skus: [{ id: "55555555-5555-4555-8555-555555555555", name: "\u5C0F\u718A", image_paths: ["private/sku.png"], measurement_revision: 1 }] };
        return Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve);
      } };
      return chain;
    } };
  }
});

// stub:media
var media_exports = {};
__export(media_exports, {
  DERIVATIVE_WIDTHS: () => DERIVATIVE_WIDTHS,
  signDerivativeUrls: () => signDerivativeUrls
});
var DERIVATIVE_WIDTHS, signDerivativeUrls;
var init_media = __esm({
  "stub:media"() {
    DERIVATIVE_WIDTHS = { thumbnail: 320 };
    signDerivativeUrls = async (paths) => paths.map(() => "https://media.example/thumb.png");
  }
});

// src/server/handheld-work-items.server.ts
init_client();

// stub:scope
var resolveNotificationScope = async (input) => ({ user_id: input.userId, device_id: input.deviceId, device_location_id: input.deviceLocationId, location_ids: globalThis.__workItemsLocal.generalLocations, is_hq: globalThis.__workItemsLocal.generalHq });

// stub:support
var resolveSupportAccess = async () => ({ is_hq_agent: globalThis.__workItemsLocal.supportHq, location_ids: globalThis.__workItemsLocal.supportLocations });

// src/lib/handheld/work-items.ts
import { z as z2 } from "zod";

// src/lib/handheld/unread-counts.ts
import * as z from "zod";
var UNREAD_COUNT_KEYS = ["customers", "internal", "orders", "system", "total"];
var count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var UnreadCountsData = z.object({
  customers: count,
  internal: count,
  orders: count,
  system: count,
  total: count
});
function parseUnreadCounts(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not_object" };
  const r = raw;
  const out = {};
  for (const k of UNREAD_COUNT_KEYS) {
    const v = r[k];
    const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return { ok: false, reason: `invalid_${k}` };
    out[k] = n;
  }
  if (out.customers + out.internal + out.orders + out.system !== out.total) return { ok: false, reason: "total_mismatch" };
  return { ok: true, data: out };
}

// src/lib/handheld/work-items.ts
var uuid = z2.string().uuid();
var boolFlag = z2.enum(["true", "false"]).optional().transform((v) => v === "true");
var workItemsInput = z2.object({
  location_id: uuid.optional(),
  limit: z2.coerce.number().int().min(1).max(100).default(50),
  cursor: z2.string().max(160).optional(),
  include_ignored: boolFlag,
  ignored_only: boolFlag
}).strict();
function decodeWorkCursor(cursor) {
  if (!cursor) return null;
  const parts = cursor.split("|");
  if (parts.length !== 2 || !uuid.safeParse(parts[1]).success || !/^\d{4}-\d\d-\d\dT/.test(parts[0]) || !Number.isFinite(Date.parse(parts[0]))) throw new Error("invalid_cursor");
  return { ts: parts[0], id: parts[1] };
}
function parseWorkCounts(raw) {
  const parsed = parseUnreadCounts(raw);
  if (!parsed.ok) throw new Error("pending_counts_contract_error");
  return parsed.data;
}

// src/server/support-measurement.server.ts
init_client();

// src/server/storefront-order-list.server.ts
function classifyImageValue(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;
  if (value.startsWith("data:")) return null;
  if (/^https?:\/\//i.test(value) || value.includes("/")) return { kind: "path", value };
  return null;
}
function fromImageList(raw) {
  if (!Array.isArray(raw)) return null;
  for (const value of raw) {
    const ref = classifyImageValue(value);
    if (ref) return ref;
  }
  return null;
}
function fromSku(sku) {
  if (!sku) return null;
  return fromImageList(sku.image_paths) ?? classifyImageValue(sku.image_url ?? null);
}
function resolveItemImageRef(item) {
  return classifyImageValue(item.image_snapshot) ?? fromImageList(item.listing?.image_paths) ?? classifyImageValue(item.listing?.cover_url ?? null) ?? fromSku(item.sku ?? null) ?? fromSku(item.listing?.sku ?? null);
}

// src/server/support-measurement.server.ts
async function measurementThumbnails(skus, sign) {
  const refs = new Map(skus.map((sku) => [sku.id, resolveItemImageRef({ id: sku.id, sku })]));
  const paths = [...new Set([...refs.values()].filter((ref) => ref?.kind === "path").map((ref) => ref.value))];
  let urls = [];
  try {
    if (paths.length) {
      if (sign) urls = await sign(paths);
      else {
        const { signDerivativeUrls: signDerivativeUrls2, DERIVATIVE_WIDTHS: DERIVATIVE_WIDTHS2 } = await Promise.resolve().then(() => (init_media(), media_exports));
        urls = await signDerivativeUrls2(paths, DERIVATIVE_WIDTHS2.thumbnail);
      }
    }
  } catch {
  }
  const signed = new Map(paths.map((path, i) => [path, urls[i] ?? null]));
  return new Map(skus.map((sku) => {
    const ref = refs.get(sku.id);
    return [sku.id, ref?.kind === "path" ? signed.get(ref.value) ?? null : null];
  }));
}
async function loadSupportMeasurementCards(conversation, messages, deps = {}) {
  const out = /* @__PURE__ */ new Map();
  const source = messages.filter((m) => m.measurement_task_id && !m.internal && (m.card_kind === "measurement_request" || m.card_kind === "measurement_completed"));
  if (!source.length || !conversation.customer_id || !conversation.location_id) return out;
  const client = deps.client ?? (await Promise.resolve().then(() => (init_client(), client_exports))).supabaseAdmin;
  const ids = [...new Set(source.map((m) => m.measurement_task_id))];
  const [tasks, links] = await Promise.all([
    client.from("product_measurement_tasks").select("id,sku_id,listing_id,location_id,status").in("id", ids),
    client.from("product_measurement_requesters").select("task_id,customer_id,conversation_id").eq("customer_id", conversation.customer_id).eq("conversation_id", conversation.id).in("task_id", ids)
  ]);
  if (tasks.error || links.error) throw new Error("measurement_card_read_failed");
  const linked = new Set((links.data ?? []).filter((r) => r.customer_id === conversation.customer_id && r.conversation_id === conversation.id).map((r) => r.task_id));
  const authorized = (tasks.data ?? []).filter((t) => linked.has(t.id) && t.location_id === conversation.location_id && ["pending", "claimed", "completed", "cancelled"].includes(t.status));
  if (!authorized.length) return out;
  const skus = await client.from("inv_skus").select("id,name,image_paths,image_url,measurement_revision,measurement_height_cm,measurement_width_cm,measurement_depth_cm,measurement_diameter_cm").in("id", [...new Set(authorized.map((t) => t.sku_id))]);
  if (skus.error) throw new Error("measurement_card_read_failed");
  const skuMap = new Map((skus.data ?? []).map((s) => [s.id, s]));
  const images = await measurementThumbnails([...skuMap.values()], deps.sign);
  const taskMap = new Map(authorized.map((t) => [t.id, t]));
  for (const message of source) {
    const task = taskMap.get(message.measurement_task_id);
    const sku = task ? skuMap.get(task.sku_id) : null;
    if (!task || !sku) continue;
    out.set(message.id, {
      task_id: task.id,
      sku_id: sku.id,
      listing_id: task.listing_id ?? null,
      product_name: sku.name || "\u5F85\u6D4B\u91CF\u5546\u54C1",
      image_url: images.get(sku.id) ?? null,
      status: task.status,
      measurement_revision: sku.measurement_revision ?? 0,
      measurement: {
        height_cm: sku.measurement_height_cm ?? null,
        width_cm: sku.measurement_width_cm ?? null,
        depth_cm: sku.measurement_depth_cm ?? null,
        diameter_cm: sku.measurement_diameter_cm ?? null
      }
    });
  }
  return out;
}

// src/server/handheld-work-items.server.ts
async function resolveWorkScope(input) {
  const [general, support] = await Promise.all([
    resolveNotificationScope({
      userId: input.userId,
      deviceId: input.deviceId ?? "",
      deviceLocationId: input.deviceLocationId ?? null
    }),
    resolveSupportAccess(input.userId)
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
    support_include_unlocated: support.is_hq_agent
  };
}
function applyWorkLocation(scope, raw) {
  const wanted = raw?.trim().toLowerCase();
  if (!wanted) return { ok: true, scope };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(wanted))
    return { ok: false, code: "validation_error" };
  if (![...scope.location_ids, ...scope.support_location_ids].includes(wanted))
    return { ok: false, code: "location_forbidden" };
  return { ok: true, scope: { ...scope, filter_location_id: wanted } };
}
function generalWorkLocationIds(scope) {
  return scope.filter_location_id ? scope.location_ids.filter((id) => id === scope.filter_location_id) : scope.location_ids;
}
function supportWorkLocationIds(scope) {
  return scope.filter_location_id ? scope.support_location_ids.filter((id) => id === scope.filter_location_id) : scope.support_location_ids;
}
function scopeArgs(scope) {
  return {
    p_user_id: scope.user_id,
    p_location_ids: generalWorkLocationIds(scope),
    p_include_unlocated: scope.is_hq && !scope.filter_location_id,
    p_support_location_ids: supportWorkLocationIds(scope),
    p_support_include_unlocated: scope.support_include_unlocated && !scope.filter_location_id
  };
}
function includesGeneralLocation(scope, id) {
  return id ? generalWorkLocationIds(scope).includes(id) : scope.is_hq && !scope.filter_location_id;
}
function includesSupportLocation(scope, id) {
  return id ? supportWorkLocationIds(scope).includes(id) : scope.support_include_unlocated && !scope.filter_location_id;
}
async function loadPendingCounts(scope) {
  const { data, error } = await supabaseAdmin.rpc(
    "handheld_pending_counts_scoped",
    scopeArgs(scope)
  );
  if (error) throw new Error("pending_counts_unavailable");
  return parseWorkCounts(data);
}
async function loadWorkItems(scope, limit = 50, cursor, opts) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_limit");
  const parsed = decodeWorkCursor(cursor);
  const { data, error } = await supabaseAdmin.rpc(
    "handheld_work_items_scoped",
    {
      ...scopeArgs(scope),
      p_limit: limit,
      p_cursor_ts: parsed?.ts,
      p_cursor_id: parsed?.id,
      p_include_ignored: opts?.includeIgnored === true,
      p_ignored_only: opts?.ignoredOnly === true
    }
  );
  if (error || !data || typeof data !== "object" || Array.isArray(data))
    throw new Error("work_items_unavailable");
  const raw = data;
  if (!Array.isArray(raw.items) || typeof raw.has_more !== "boolean" || raw.items.some(
    (r) => !r || [r.id, r.type, r.title, r.description, r.action, r.target_id].some(
      (v) => typeof v !== "string"
    )
  ))
    throw new Error("work_items_contract_error");
  const counts = parseWorkCounts(raw.counts);
  let next_cursor = null;
  if (raw.has_more) {
    if (!raw.last_ts || !raw.last_id) throw new Error("work_items_cursor_contract_error");
    next_cursor = `${raw.last_ts}|${raw.last_id}`;
    decodeWorkCursor(next_cursor);
  }
  const imageByItem = /* @__PURE__ */ new Map();
  const conversationIds = [
    ...new Set(
      raw.items.filter((r) => r.conversation_id && r.sku_id).map((r) => r.conversation_id)
    )
  ];
  if (conversationIds.length) {
    const result = await supabaseAdmin.from("support_conversations").select("id,customer_id,location_id").in("id", conversationIds);
    if (result.error) throw new Error("work_items_unavailable");
    const conversations = (result.data ?? []).filter(
      (c) => includesSupportLocation(scope, c.location_id)
    );
    if (conversations.length) {
      const requests = await supabaseAdmin.from("product_measurement_requesters").select("task_id,customer_id,conversation_id").in(
        "conversation_id",
        conversations.map((c) => c.id)
      );
      if (requests.error) throw new Error("work_items_unavailable");
      const links = requests.data ?? [];
      await Promise.all(
        conversations.map(async (conversation) => {
          const messages = links.filter(
            (link) => link.conversation_id === conversation.id && link.customer_id === conversation.customer_id
          ).map((link) => ({
            id: link.task_id,
            measurement_task_id: link.task_id,
            card_kind: "measurement_request"
          }));
          const cards = await loadSupportMeasurementCards(conversation, messages);
          for (const row of raw.items.filter((r) => r.conversation_id === conversation.id)) {
            imageByItem.set(
              row.id,
              [...cards.values()].find((card) => card.sku_id === row.sku_id)?.image_url ?? null
            );
          }
        })
      );
    }
  }
  const orphanRows = raw.items.filter(
    (r) => r.action === "measurement_task" && !r.conversation_id && r.sku_id
  );
  if (orphanRows.length) {
    const result = await supabaseAdmin.from("product_measurement_tasks").select("id,sku_id,location_id,status").in(
      "id",
      orphanRows.map((r) => r.target_id)
    );
    if (result.error) throw new Error("work_items_unavailable");
    const tasks = (result.data ?? []).filter(
      (task) => includesGeneralLocation(scope, task.location_id) && ["pending", "claimed"].includes(task.status) && orphanRows.some((r) => r.target_id === task.id && r.sku_id === task.sku_id)
    );
    if (tasks.length) {
      const skus = await supabaseAdmin.from("inv_skus").select("id,image_paths,image_url").in(
        "id",
        tasks.map((task) => task.sku_id)
      );
      if (skus.error) throw new Error("work_items_unavailable");
      const images = await measurementThumbnails(skus.data ?? []);
      for (const task of tasks) {
        const row = orphanRows.find((r) => r.target_id === task.id && r.sku_id === task.sku_id);
        imageByItem.set(row.id, images.get(task.sku_id) ?? null);
      }
    }
  }
  const items = raw.items.map((row) => ({
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
    can_restore: row.can_restore === true
  }));
  return { items, counts, next_cursor };
}
export {
  applyWorkLocation,
  generalWorkLocationIds,
  loadPendingCounts,
  loadWorkItems,
  resolveWorkScope
};
