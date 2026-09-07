/**
 * BOOMER GO(店员端) → ERP 只读桥接（服务端专用）。
 *
 * 安全边界：
 *  - 只接受固定 GO issuer（项目 narqwgwpqglathwtyevz）签发的 Supabase access token，
 *    并且必须由该 issuer 的 auth.getUser(token) 实际核验，不做本地 RS256 自签解析，
 *    也不复用消费者 JWT 通道。
 *  - 不需要 GO 的 service key：核验通过后，用「用户本人的 token」调用 GO 的
 *    erp_verify_current_scope_v1，由 GO 侧返回唯一可信的 erp_user_id / 范围 / 当天门店。
 *  - ERP 侧只做"否决"：显式 revoked 的绑定优先拒绝；没有记录时复用 GO 的可信映射，
 *    不再增加第二次人工审核门槛。
 *  - 员工当天门店必须同时是：可信映射的 ERP 门店、真实启用门店、且该账号仍有门店权限。
 *  - 手持设备（X-Device-Token / X-Session-Token）语义完全不受影响。
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  GoScopeError,
  resolveGoScope,
  type GoScope,
  type ScheduleState,
} from "@/lib/go-bridge/scope";
import { maskName, maskPhone } from "@/lib/go-bridge/scope";
import {
  parseGoVerifyPayload,
  resolveErpStoreLocation,
  type GoShopMapping,
} from "@/lib/go-bridge/verify-scope";
import { buildShopDirectory, type GoShopDirectoryEntry } from "@/lib/go-bridge/shops";
import { assertGoScopeSynced, type GoSyncRow } from "@/lib/go-bridge/sync-state";
import { buildGoDailySummary, type GoStoreInput } from "@/lib/go-bridge/daily-contract";
import { shanghaiToday, shanghaiDayWindow } from "@/lib/store-targets/sales-window";

export { GoScopeError };

/** 固定 GO issuer —— 只认这个项目签发的 token */
export const GO_PROJECT_REF = "narqwgwpqglathwtyevz";
/** 固定完整 origin —— 必须整体相等，不能用 includes 子串判断 */
export const GO_SUPABASE_ORIGIN = `https://${GO_PROJECT_REF}.supabase.co`;
/** GO 侧提供的可信范围函数（无参数） */
export const GO_SCOPE_RPC = "erp_verify_current_scope_v1";

type GoEnv = { url: string; publishableKey: string; projectRef: string };

export function goEnvironment(): GoEnv | null {
  const url = process.env["GO_SUPABASE_URL"]?.trim();
  const publishableKey =
    process.env["GO_SUPABASE_PUBLISHABLE_KEY"]?.trim() ||
    process.env["GO_SUPABASE_ANON_KEY"]?.trim();
  if (!url || !publishableKey) return null;
  // issuer 必须是固定 GO 项目的完整 origin，配错了宁可不服务
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  if (origin !== GO_SUPABASE_ORIGIN) return null;
  return { url: origin, publishableKey, projectRef: GO_PROJECT_REF };
}

function goClient(env: GoEnv, userToken?: string): SupabaseClient {
  const key = env.publishableKey;
  return createClient(env.url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("apikey", key);
        if (userToken) headers.set("Authorization", `Bearer ${userToken}`);
        else if (key.startsWith("sb_")) headers.delete("Authorization");
        return fetch(input as RequestInfo, { ...init, headers });
      },
    },
  });
}

export function bearerToken(request: Request): string | null {
  const raw = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
}

export type GoActor = {
  go_user_id: string;
  erp_user_id: string;
  display_name: string | null;
  phone_masked: string | null;
  roles: string[];
  is_hq: boolean;
  scope: "hq" | "store";
  today: string;
  schedule_state: ScheduleState;
  today_location: { id: string; name: string } | null;
  /** HQ 可浏览的全部真实门店；员工为空数组 */
  hq_locations: { id: string; name: string }[];
  permitted_location_ids: string[];
  /** 跨项目门店编号契约：只含显式 active 映射 */
  shops: GoShopDirectoryEntry[];
  reasons: string[];
};

const HQ_ROLES = new Set(["super_admin", "hq_operator"]);

const sb = () =>
  supabaseAdmin as unknown as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from: (t: string) => any;
    auth: typeof supabaseAdmin.auth;
  };

/** 全部真实门店（kind=shop 且启用），仓库不计入 */
async function loadRealShops(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await sb()
    .from("inv_locations")
    .select("id, name, kind, is_active")
    .eq("kind", "shop")
    .eq("is_active", true);
  if (error) throw new GoScopeError("locations_unavailable", "门店列表暂时不可用", 503);
  return ((data ?? []) as { id: string; name: string }[])
    .map((r) => ({ id: r.id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

async function loadPermittedLocationIds(erpUserId: string): Promise<string[]> {
  const { data, error } = await sb()
    .from("user_location_perms")
    .select("location_id")
    .eq("user_id", erpUserId);
  if (error) throw new GoScopeError("permissions_unavailable", "门店权限暂时不可用", 503);
  return ((data ?? []) as { location_id: string }[]).map((r) => r.location_id);
}

/** 核验 GO token 并解析出 ERP 侧可信身份与当天门店 */
export async function authenticateGoActor(request: Request, now = new Date()): Promise<GoActor> {
  const env = goEnvironment();
  if (!env) throw new GoScopeError("go_bridge_not_configured", "GO 桥接尚未配置", 503);

  const token = bearerToken(request);
  if (!token) throw new GoScopeError("missing_token", "缺少 GO 访问令牌", 401);

  // 1) 固定 issuer 实际核验 token
  const { data: userData, error: userErr } = await goClient(env).auth.getUser(token);
  if (userErr || !userData?.user) {
    throw new GoScopeError("invalid_go_token", "GO 访问令牌无效或已过期", 401);
  }
  const goUserId = userData.user.id;

  const today = shanghaiToday(now);

  // 2) 以用户本人 token 调 GO 的可信范围函数（**无参数**，传参会 PGRST202）
  const asUser = goClient(env, token);
  const { data: scopeRaw, error: scopeErr } = await asUser.rpc(GO_SCOPE_RPC);
  if (scopeErr) {
    throw new GoScopeError("go_scope_unavailable", "GO 身份/排班服务暂时不可用", 503);
  }
  const verified = parseGoVerifyPayload(scopeRaw, {
    expectedDate: today,
    expectedGoUserId: goUserId,
  });
  const erpUserId = verified.erpUserId;

  // 3) ERP 侧只做否决：显式 revoked 优先拒绝；不一致也拒绝；没有记录则复用 GO 可信映射
  const { data: erpLinkRow, error: erpLinkErr } = await sb()
    .from("go_identity_links")
    .select("erp_user_id, status")
    .eq("go_project_ref", env.projectRef)
    .eq("go_user_id", goUserId)
    .maybeSingle();
  if (erpLinkErr) throw new GoScopeError("identity_unavailable", "身份登记暂不可用", 503);
  const erpLink = erpLinkRow as { erp_user_id: string | null; status: string } | null;
  const reasons: string[] = [...verified.reasons];
  if (erpLink) {
    if (erpLink.status === "revoked") {
      throw new GoScopeError("identity_revoked", "该 GO 账号在 ERP 已被停用", 403);
    }
    if (erpLink.erp_user_id && erpLink.erp_user_id !== erpUserId) {
      throw new GoScopeError("identity_mismatch", "GO 与 ERP 的账号绑定不一致", 403);
    }
  } else {
    reasons.push("erp_link_from_go_trusted_mapping");
  }

  // 4) ERP 账号状态（停用 / 删除即拒绝）
  const { data: erpUser, error: erpUserErr } = await sb().auth.admin.getUserById(erpUserId);
  if (erpUserErr || !erpUser?.user) {
    throw new GoScopeError("erp_account_missing", "ERP 账号不存在", 403);
  }
  const u = erpUser.user as unknown as Record<string, unknown>;
  if (u["banned_until"] && new Date(String(u["banned_until"])).getTime() > now.getTime()) {
    throw new GoScopeError("erp_account_disabled", "ERP 账号已停用", 403);
  }
  if (u["deleted_at"]) throw new GoScopeError("erp_account_disabled", "ERP 账号已停用", 403);

  // 5) 当前角色实时读取，不信任 token / GO 里的角色声明
  const { data: roleRows, error: roleErr } = await sb()
    .from("user_roles")
    .select("role")
    .eq("user_id", erpUserId);
  if (roleErr) throw new GoScopeError("roles_unavailable", "角色信息暂不可用", 503);
  const roles = ((roleRows as { role: string }[] | null) ?? []).map((r) => r.role);
  if (roles.length === 0) throw new GoScopeError("no_erp_role", "该账号在 ERP 尚未配置角色", 403);

  // HQ 由 ERP 显式角色判定，不由 GO 的 scope 决定，也不由"没有门店"反推
  const isHq = roles.some((r) => HQ_ROLES.has(r));

  // 5.1) 撤销类变更未同步到 GO 前一律 fail closed
  const { data: syncRows, error: syncErr } = await sb()
    .from("go_scope_sync_outbox")
    .select("subject_type, subject_key, change_kind, status, attempts")
    .eq("go_project_ref", env.projectRef)
    .eq("target_user_id", erpUserId)
    .neq("status", "synced");
  if (syncErr) throw new GoScopeError("scope_sync_unavailable", "权限同步状态不可用", 503);
  assertGoScopeSynced((syncRows ?? []) as GoSyncRow[]);

  // 5.2) ERP 实时角色与 GO 上下文不一致 → 明确「上下文过期，请刷新」，不悄悄降级
  if (isHq !== (verified.scope === "hq")) {
    throw new GoScopeError("go_scope_stale", "GO 范围上下文已过期，请刷新后重试", 409);
  }

  const allShops = await loadRealShops();
  const permitted = await loadPermittedLocationIds(erpUserId);

  const { data: linkRows, error: linksErr } = await sb()
    .from("go_shop_location_links")
    .select("go_shop_id, location_id, status")
    .eq("go_project_ref", env.projectRef);
  if (linksErr) throw new GoScopeError("shop_mapping_unavailable", "门店映射暂不可用", 503);
  const links = (linkRows ?? []) as {
    go_shop_id: string;
    location_id: string;
    status: string;
  }[];
  const shops = buildShopDirectory({ links, activeShops: allShops });

  let scheduleState: ScheduleState = "scheduled";
  let todayLocationId: string | null = null;
  if (!isHq) {
    scheduleState = verified.scheduleState;
    const goShopId = verified.effectiveShop?.id ?? null;
    if (scheduleState === "scheduled" && goShopId) {
      const mapped = links.find((l) => l.go_shop_id === goShopId) ?? null;
      todayLocationId = resolveErpStoreLocation({
        goShopId,
        mapping: mapped
          ? ({
              location_id: mapped.location_id,
              status: mapped.status,
            } satisfies NonNullable<GoShopMapping>)
          : null,
        activeShopIds: allShops.map((l) => l.id),
        permittedLocationIds: permitted,
      });
    }
  }

  const meta = (erpUser.user.user_metadata ?? {}) as Record<string, unknown>;
  return {
    go_user_id: goUserId,
    erp_user_id: erpUserId,
    display_name: maskName((meta["name"] as string | undefined) ?? null),
    phone_masked: maskPhone((meta["phone"] as string | undefined) ?? erpUser.user.phone ?? null),
    roles,
    is_hq: isHq,
    scope: isHq ? "hq" : "store",
    today,
    schedule_state: scheduleState,
    today_location: todayLocationId
      ? { id: todayLocationId, name: allShops.find((l) => l.id === todayLocationId)?.name ?? "" }
      : null,
    hq_locations: isHq ? allShops : [],
    permitted_location_ids: permitted,
    shops,
    reasons,
  };
}

export function goSessionPayload(actor: GoActor) {
  const visible = actor.is_hq
    ? actor.hq_locations
    : actor.today_location
      ? [actor.today_location]
      : [];
  return {
    go_user_id: actor.go_user_id,
    erp_user_id: actor.erp_user_id,
    display_name: actor.display_name,
    phone_masked: actor.phone_masked,
    scope: actor.scope,
    roles: actor.roles,
    today: actor.today,
    schedule_state: actor.schedule_state,
    today_location: actor.today_location,
    visible_locations: visible,
    /** 跨项目门店编号契约：go_shop_id ↔ erp_location_id ↔ name */
    shops: actor.shops,
    reasons: actor.reasons,
  };
}

export function scopeForActor(actor: GoActor, requestedLocationId: string | null): GoScope {
  return resolveGoScope({
    isHq: actor.is_hq,
    requestedLocationId,
    scheduleState: actor.schedule_state,
    scheduledLocationId: actor.today_location?.id ?? null,
    hqLocationIds: actor.hq_locations.map((l) => l.id),
  });
}

// ------------------------------------------------------- 当日实绩（安全适配层）
// 这里不复用会吞掉 error 的既有聚合：每一次查询都检查 error，失败即 status=error。

class SourceError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

/** 该业务日是否被"已完成"的同步窗口完整覆盖（单页 ok 不能冒充整日） */
async function dayCoveredBySync(shopId: string, startUtc: string, endUtc: string) {
  const { data, error } = await sb()
    .from("youzan_order_sync_cursors")
    .select("window_start, window_end, status")
    .eq("shop_id", shopId)
    .eq("status", "done")
    .lt("window_start", endUtc)
    .gt("window_end", startUtc);
  if (error) throw new SourceError("sync_cursor_read_failed", error.message);
  const rows = ((data ?? []) as { window_start: string; window_end: string }[])
    .map((r) => [new Date(r.window_start).getTime(), new Date(r.window_end).getTime()] as const)
    .sort((a, b) => a[0] - b[0]);
  let cursor = new Date(startUtc).getTime();
  const end = new Date(endUtc).getTime();
  for (const [s, e] of rows) {
    if (s > cursor) break;
    if (e > cursor) cursor = e;
    if (cursor >= end) return true;
  }
  return cursor >= end;
}

async function loadStoreFacts(params: {
  locationId: string;
  name: string;
  date: string;
}): Promise<GoStoreInput> {
  const { startUtc, endUtc } = shanghaiDayWindow(params.date);
  try {
    const { data: loc, error: locErr } = await sb()
      .from("inv_locations")
      .select("id, name, shop_id")
      .eq("id", params.locationId)
      .maybeSingle();
    if (locErr) throw new SourceError("location_read_failed", locErr.message);
    const shopId: string | null = (loc as { shop_id: string | null } | null)?.shop_id ?? null;

    let youzanFen: number | null = 0;
    let youzanOrders: number | null = 0;
    let syncedThrough: string | null = null;
    let covered = false;

    if (shopId) {
      const { data: rows, error: ordErr } = await sb()
        .from("youzan_orders")
        .select("status, pay_time, payment, total_fee")
        .eq("shop_id", shopId)
        .gte("pay_time", startUtc)
        .lt("pay_time", endUtc);
      if (ordErr) throw new SourceError("youzan_read_failed", ordErr.message);
      const paid = (
        (rows ?? []) as { status: string; payment: number; total_fee: number }[]
      ).filter((r) => String(r.status ?? "").toUpperCase() !== "TRADE_CLOSED");
      youzanFen = paid.reduce(
        (s, r) => s + Math.round(Number(r.payment ?? r.total_fee ?? 0) * 100),
        0,
      );
      youzanOrders = paid.length;

      const { data: syncRows, error: syncErr } = await sb()
        .from("youzan_sync_logs")
        .select("finished_at")
        .eq("shop_id", shopId)
        .eq("action", "orders")
        .eq("status", "ok")
        .order("finished_at", { ascending: false })
        .limit(1);
      if (syncErr) throw new SourceError("sync_log_read_failed", syncErr.message);
      syncedThrough = (syncRows?.[0]?.finished_at as string | undefined) ?? null;
      covered = await dayCoveredBySync(shopId, startUtc, endUtc);
    }

    const { data: offlineRows, error: offErr } = await sb()
      .from("store_offline_sales_entries")
      .select("amount_fen, order_count")
      .eq("location_id", params.locationId)
      .eq("business_date", params.date)
      .eq("status", "active");
    if (offErr) throw new SourceError("offline_read_failed", offErr.message);
    const offline = ((offlineRows ?? []) as { amount_fen: number; order_count: number }[]).reduce<{
      amount_fen: number;
      entry_count: number;
      order_count: number;
    }>(
      (acc, r) => ({
        amount_fen: acc.amount_fen + Number(r.amount_fen || 0),
        entry_count: acc.entry_count + 1,
        order_count: acc.order_count + Number(r.order_count || 0),
      }),
      { amount_fen: 0, entry_count: 0, order_count: 0 },
    );

    const { data: targetRow, error: tErr } = await sb()
      .from("store_daily_targets")
      .select("target_amount_fen")
      .eq("location_id", params.locationId)
      .eq("target_date", params.date)
      .maybeSingle();
    if (tErr) throw new SourceError("target_read_failed", tErr.message);

    return {
      status: "ok",
      location_id: params.locationId,
      name: params.name,
      target_fen: targetRow
        ? Number((targetRow as { target_amount_fen: number }).target_amount_fen)
        : null,
      youzan_fen: youzanFen,
      offline_fen: offline.amount_fen,
      youzan_order_count: youzanOrders,
      offline_order_count: offline.order_count,
      youzan_bound: Boolean(shopId),
      youzan_synced_through: syncedThrough,
      day_covered_by_sync: covered,
      // 本地暂无有赞退款数据源 → 只能是已付款毛额口径
      has_refund_source: false,
      offline_entry_count: offline.entry_count,
    };
  } catch (e) {
    return {
      status: "error",
      location_id: params.locationId,
      name: params.name,
      code: e instanceof SourceError ? e.code : "store_summary_failed",
      message: e instanceof Error ? e.message.slice(0, 200) : undefined,
    };
  }
}

export async function loadGoDailySummary(params: {
  actor: GoActor;
  scope: GoScope;
  date: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const names = new Map(params.actor.hq_locations.map((l) => [l.id, l.name]));
  if (params.actor.today_location) {
    names.set(params.actor.today_location.id, params.actor.today_location.name);
  }

  const stores: GoStoreInput[] = [];
  for (const locationId of params.scope.locationIds) {
    stores.push(
      await loadStoreFacts({
        locationId,
        name: names.get(locationId) ?? "未知门店",
        date: params.date,
      }),
    );
  }

  return buildGoDailySummary({
    date: params.date,
    scope: params.scope,
    stores,
    generatedAt: now.toISOString(),
  });
}

// ---------------------------------------------------------------- HTTP 辅助

export const GO_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export function goJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...GO_CORS },
  });
}

export function goError(e: unknown) {
  if (e instanceof GoScopeError) {
    return goJson({ ok: false, code: e.code, error: e.message }, e.status);
  }
  return goJson({ ok: false, code: "internal_error", error: "服务暂时不可用" }, 500);
}
