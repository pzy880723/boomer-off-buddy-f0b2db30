// 多渠道销售 v1 服务端：员工授权、事实读取、写入 RPC 调用、消费端过滤。
// 所有写入只经 0117 service_role RPC；本模块不调用任何有赞接口。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { authenticateDevice, resolveSessionUser } from "@/server/handheld-auth.server";
import { consumerAuthEnvironment, verifyConsumerJwt } from "@/server/consumer-auth.server";
import {
  buildChannelViews,
  catalogDisplayChannel,
  consumerChannelAllowed,
  resolveConsumerChannel,
  type ChannelFacts,
  type ConsumerChannel,
  type IntentFact,
  type SalesChannel,
} from "@/lib/sales-channels/model";

const MANAGE_ROLES = ["super_admin", "hq_operator", "store_manager"];
const HQ_ROLES = ["super_admin", "hq_operator"];
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export class SalesChannelError extends Error {
  constructor(message: string, public status: number, public code: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

const db = supabaseAdmin as unknown as {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export type StaffContext = { userId: string; locationId: string; shopId: string | null; canManage: boolean };

/** 设备 + 员工会话 + 角色 + 门店（总部可访问任一门店，其余须显式授权；仅 kind=shop）。 */
export async function authorizeSalesChannelStaff(request: Request, locationId: unknown): Promise<StaffContext> {
  const device = await authenticateDevice(request);
  if (!device.ok) throw new SalesChannelError("Device unauthorized", 401, "device_unauthorized");
  const session = await resolveSessionUser(request);
  if (!session) throw new SalesChannelError("Employee session required", 401, "session_required");
  if (typeof locationId !== "string" || !UUID.test(locationId)) {
    throw new SalesChannelError("location_id required", 400, "location_required");
  }
  const { data: roleRows, error: roleError } = await db.from("user_roles").select("role").eq("user_id", session.user_id);
  if (roleError) throw new SalesChannelError("Unable to load access", 500, "access_query_failed");
  const roles = ((roleRows ?? []) as Array<{ role: string }>).map((r) => r.role);
  const isHq = roles.some((r) => HQ_ROLES.includes(r));
  if (!isHq) {
    const { data: perm, error } = await db.from("user_location_perms").select("location_id")
      .eq("user_id", session.user_id).eq("location_id", locationId).maybeSingle();
    if (error) throw new SalesChannelError("Unable to load access", 500, "access_query_failed");
    if (!perm) throw new SalesChannelError("Location not accessible", 403, "location_forbidden");
  }
  const { data: loc, error: locError } = await db.from("inv_locations").select("id, kind, shop_id, is_active")
    .eq("id", locationId).maybeSingle();
  if (locError) throw new SalesChannelError("Unable to load location", 500, "access_query_failed");
  if (!loc || !loc.is_active || loc.kind !== "shop") {
    throw new SalesChannelError("仅门店可设置销售渠道", 403, "location_forbidden");
  }
  return { userId: session.user_id, locationId, shopId: loc.shop_id ?? null, canManage: roles.some((r) => MANAGE_ROLES.includes(r)) };
}

function must<T>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new SalesChannelError("渠道资料读取失败", 500, "channel_query_failed");
  return r.data;
}

/** 读取一个门店下若干 SKU 的渠道事实（≤100）。 */
export async function loadChannelFacts(ctx: Pick<StaffContext, "locationId" | "shopId">, skuIds: string[]) {
  const ids = [...new Set(skuIds)];
  const [stocks, skus, listings, intents, yz, shop] = await Promise.all([
    db.from("inv_stocks").select("sku_id, qty").eq("location_id", ctx.locationId).in("sku_id", ids),
    db.from("inv_skus").select("id, sales_state").in("id", ids),
    db.from("commerce_listings").select("sku_id, status, readiness_hold").eq("location_id", ctx.locationId).in("sku_id", ids),
    db.from("sku_sales_channel_intents").select("sku_id, channel, enabled, version").eq("location_id", ctx.locationId).in("sku_id", ids),
    ctx.shopId
      ? db.from("sku_channel_listings").select("id, sku_id, external_item_id, listing_status, last_verified_at, updated_at")
          .eq("channel", "youzan_branch_offline").eq("shop_id", ctx.shopId).in("sku_id", ids)
      : Promise.resolve({ data: [], error: null }),
    ctx.shopId
      ? db.from("youzan_shops").select("id, expires_at, access_token").eq("id", ctx.shopId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const yzRows = (must(yz) ?? []) as Array<{ id: string; sku_id: string; external_item_id: string | null; listing_status: string | null; last_verified_at: string | null; updated_at: string }>;
  const yzIds = yzRows.map((r) => r.id);
  // 每个映射取最近一条意图任务：进行中 = syncing；终止失败（凭据过期/无权限/回查不达标）= error
  const tasks = yzIds.length
    ? (must(await db.from("channel_sync_outbox").select("channel_listing_id, status, created_at")
        .in("channel_listing_id", yzIds).eq("request_payload->>source", "sales_channel_intent")
        .order("created_at", { ascending: false }).limit(500)) ?? []) as Array<{ channel_listing_id: string; status: string }>
    : [];
  const latestTask = new Map<string, string>();
  for (const t of tasks) if (!latestTask.has(t.channel_listing_id)) latestTask.set(t.channel_listing_id, t.status);
  const shopRow = must(shop) as { id: string; expires_at: string | null; access_token: string | null } | null;
  const shopFacts = {
    bound: !!shopRow,
    authorized: !!shopRow?.access_token && (!shopRow.expires_at || Date.parse(shopRow.expires_at) > Date.now()),
  };
  const stockRows = (must(stocks) ?? []) as Array<{ sku_id: string; qty: number }>;
  const skuRows = (must(skus) ?? []) as Array<{ id: string; sales_state: string | null }>;
  const listingRows = (must(listings) ?? []) as Array<{ sku_id: string; status: string; readiness_hold: boolean | null }>;
  const intentRows = (must(intents) ?? []) as Array<{ sku_id: string } & IntentFact>;
  const out = new Map<string, ChannelFacts>();
  for (const id of ids) {
    const y = yzRows.filter((r) => r.sku_id === id).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
    const stock = stockRows.find((s) => s.sku_id === id);
    out.set(id, {
      stockQty: stock ? Number(stock.qty) : null,
      salesState: skuRows.find((s) => s.id === id)?.sales_state ?? null,
      listing: listingRows.find((l) => l.sku_id === id) ?? null,
      shop: shopFacts,
      youzan: y,
      youzanPending: !!y && ["pending", "running", "retry_wait"].includes(latestTask.get(y.id) ?? ""),
      youzanFailed: !!y && latestTask.get(y.id) === "dead_letter",
      intents: intentRows.filter((i) => i.sku_id === id).map((i) => ({ channel: i.channel, enabled: i.enabled, version: Number(i.version) })),
    });
  }
  return out;
}

export async function channelStateResponse(ctx: StaffContext, skuId: string) {
  const facts = (await loadChannelFacts(ctx, [skuId])).get(skuId)!;
  return {
    sku_id: skuId,
    location_id: ctx.locationId,
    can_manage: ctx.canManage,
    stock_quantity: facts.stockQty ?? 0,
    channels: buildChannelViews(facts),
  };
}

const DB_ERRORS: Record<string, [number, string, string]> = {
  role_forbidden: [403, "role_forbidden", "当前角色不能修改销售渠道"],
  location_forbidden: [403, "location_forbidden", "无权操作该门店"],
  op_id_conflict: [409, "op_id_conflict", "操作编号已用于其他请求"],
  batch_limit: [422, "batch_limit", "单次最多 100 件商品"],
  preview_invalid: [404, "preview_invalid", "预览不存在或不属于当前账号与门店"],
  preview_consumed: [409, "preview_consumed", "该预览已执行，请重新预览"],
  preview_expired: [410, "preview_expired", "预览已过期，请重新预览"],
  preview_empty: [422, "preview_empty", "预览中没有可执行的变更"],
  invalid_request: [400, "invalid_body", "请求参数不正确"],
  duplicate_change: [400, "duplicate_change", "同一商品同一渠道不能重复提交"],
};

export async function callApplyRpc(fn: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    const hit = Object.keys(DB_ERRORS).find((k) => error.message.includes(k));
    if (hit) {
      const [status, code, msg] = DB_ERRORS[hit];
      throw new SalesChannelError(msg, status, code);
    }
    throw new SalesChannelError("渠道保存失败", 500, "channel_apply_failed");
  }
  return data as {
    results: Array<{ sku_id: string; channel: string; success: boolean; reason?: string; status?: string; version?: number }>;
    replayed?: boolean;
    sku_ids?: string[];
    skipped?: Array<{ sku_id: string; reason: string }>;
  };
}

export async function createPreview(
  ctx: StaffContext, add: SalesChannel[], remove: SalesChannel[], items: unknown[],
  skipped: Array<{ sku_id: string; reason: string }>, skuIds: string[],
) {
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  const { data, error } = await db.from("sku_sales_channel_previews").insert({
    actor_user_id: ctx.userId, location_id: ctx.locationId, add_channels: add, remove_channels: remove,
    items, skipped, sku_ids: skuIds, expires_at: expires,
  }).select("token, expires_at").single();
  if (error || !data) throw new SalesChannelError("预览保存失败", 500, "preview_failed");
  return data as { token: string; expires_at: string };
}



// ---------------- 消费端 ----------------

/**
 * 目录展示来源：有 Bearer 时只认验签 client_kind（无效/旧会话 = unknown，取两渠道交集）；
 * 无 Bearer 时才采用 storefront_channel 查询参数（仅展示，下单另由签名会话 gate）。
 */
export async function resolveRequestConsumerChannel(request: Request): Promise<ConsumerChannel> {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return catalogDisplayChannel(new URL(request.url).searchParams.get("storefront_channel"));
  const config = consumerAuthEnvironment();
  if (!config) return "unknown";
  try {
    return resolveConsumerChannel(await verifyConsumerJwt(token, config));
  } catch {
    return "unknown";
  }
}

/** 在分页前移除当前来源被显式关闭的商品；读取失败即报错（不放行）。 */
export async function filterListingsForConsumerChannel<T extends { sku_id: string; location_id: string | null }>(
  listings: T[],
  channel: ConsumerChannel,
): Promise<T[]> {
  if (!listings.length) return listings;
  const skuIds = [...new Set(listings.map((l) => l.sku_id))];
  const disabled: Array<{ sku_id: string; location_id: string; channel: string }> = [];
  for (let i = 0; i < skuIds.length; i += 200) {
    const { data, error } = await db.from("sku_sales_channel_intents").select("sku_id, location_id, channel")
      .eq("enabled", false).in("channel", ["miniapp", "app"]).in("sku_id", skuIds.slice(i, i + 200));
    if (error) throw new Error("渠道策略读取失败");
    disabled.push(...((data ?? []) as typeof disabled));
  }
  if (!disabled.length) return listings;
  return listings.filter((l) =>
    consumerChannelAllowed(disabled.filter((d) => d.sku_id === l.sku_id && d.location_id === l.location_id), channel));
}
