/**
 * BOOMER GO(店员端) → ERP 只读桥接（服务端专用）。
 *
 * 安全边界：
 *  - 只接受 GO 项目自己签发的 Supabase access token，且必须由固定的 GO issuer
 *    (`GO_SUPABASE_URL`) 通过 auth.getUser 实际核验，不做本地 RS256 自签解析、
 *    也不复用消费者 JWT 通道。
 *  - 身份必须双向对齐：GO 侧 erp_user_links.erp_user_id ≡ ERP 侧
 *    go_identity_links.erp_user_id（status=approved）。任一缺失或不一致 → 403，
 *    绝不按手机号 / 姓名自动关联。
 *  - 手持设备（X-Device-Token / X-Session-Token）语义完全不受影响。
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  GoScopeError,
  gapFen,
  maskName,
  maskPhone,
  mergeCompleteness,
  resolveGoScope,
  sumNullable,
  type GoScope,
  type ScheduleState,
  type StoreCompleteness,
} from "@/lib/go-bridge/scope";
import { loadDailySummary } from "@/server/store-targets.server";
import { shanghaiToday } from "@/lib/store-targets/sales-window";

export { GoScopeError };

type GoEnv = {
  url: string;
  publishableKey: string;
  serviceKey: string;
  projectRef: string;
};

export function goEnvironment(): GoEnv | null {
  const url = process.env["GO_SUPABASE_URL"]?.trim();
  const publishableKey =
    process.env["GO_SUPABASE_PUBLISHABLE_KEY"]?.trim() || process.env["GO_SUPABASE_ANON_KEY"]?.trim();
  const serviceKey = process.env["GO_SUPABASE_SERVICE_ROLE_KEY"]?.trim();
  const projectRef = process.env["GO_PROJECT_REF"]?.trim();
  if (!url || !publishableKey || !serviceKey || !projectRef) return null;
  return { url, publishableKey, serviceKey, projectRef };
}

function goClient(env: GoEnv, key: string): SupabaseClient {
  return createClient(env.url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        if (key.startsWith("sb_") && headers.get("Authorization") === `Bearer ${key}`) {
          headers.delete("Authorization");
        }
        headers.set("apikey", key);
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
  hq_locations: { id: string; name: string }[];
  reasons: string[];
};

const HQ_ROLES = new Set(["super_admin", "hq_operator"]);

/** 全部真实门店（kind=shop 且启用），仓库不计入 */
async function loadRealShops(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabaseAdmin
    .from("inv_locations")
    .select("id, name, kind, is_active")
    .eq("kind", "shop")
    .eq("is_active", true);
  if (error) throw new GoScopeError("locations_unavailable", "门店列表暂时不可用", 503);
  return ((data ?? []) as { id: string; name: string }[])
    .map((r) => ({ id: r.id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

async function resolveTodaySchedule(
  env: GoEnv,
  go: SupabaseClient,
  goUserId: string,
  workDate: string,
): Promise<{ state: ScheduleState; locationId: string | null; reasons: string[] }> {
  const reasons: string[] = [];
  const { data, error } = await go
    .from("shift_schedules")
    .select("*")
    .eq("user_id", goUserId)
    .eq("work_date", workDate);
  if (error) {
    reasons.push("go_schedule_read_failed");
    return { state: "unavailable", locationId: null, reasons };
  }
  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return { state: "no_schedule", locationId: null, reasons };
  if (rows.length > 1) {
    // GO 侧有 UNIQUE(work_date,user_id)；出现多行说明约束被绕过，宁可不可用也不猜
    reasons.push("go_schedule_conflict");
    return { state: "unavailable", locationId: null, reasons };
  }
  const row = rows[0];
  const status = String(row["status"] ?? row["shift_type"] ?? "").toLowerCase();
  if (status === "off" || status === "rest" || status === "leave") {
    return { state: "off", locationId: null, reasons };
  }
  const goShopId = (row["shop_id"] ?? row["store_id"] ?? row["location_id"] ?? null) as
    | string
    | null;
  if (!goShopId) {
    reasons.push("go_schedule_missing_shop");
    return { state: "unavailable", locationId: null, reasons };
  }

  const { data: link, error: linkErr } = await supabaseAdmin
    .from("go_shop_location_links" as never)
    .select("location_id, status")
    .eq("go_project_ref", env.projectRef)
    .eq("go_shop_id", String(goShopId))
    .maybeSingle();
  if (linkErr) {
    reasons.push("shop_mapping_read_failed");
    return { state: "unavailable", locationId: null, reasons };
  }
  const mapped = link as { location_id: string; status: string } | null;
  if (!mapped || mapped.status !== "active") {
    reasons.push("shop_mapping_missing");
    return { state: "unavailable", locationId: null, reasons };
  }
  return { state: "scheduled", locationId: mapped.location_id, reasons };
}

/** 核验 GO token 并解析出 ERP 侧可信身份与当天门店 */
export async function authenticateGoActor(request: Request, now = new Date()): Promise<GoActor> {
  const env = goEnvironment();
  if (!env) {
    throw new GoScopeError("go_bridge_not_configured", "GO 桥接尚未配置", 503);
  }
  const token = bearerToken(request);
  if (!token) throw new GoScopeError("missing_token", "缺少 GO 访问令牌", 401);

  // 1) 固定 issuer 实际核验 token
  const authClient = goClient(env, env.publishableKey);
  const { data: userData, error: userErr } = await authClient.auth.getUser(token);
  if (userErr || !userData?.user) {
    throw new GoScopeError("invalid_go_token", "GO 访问令牌无效或已过期", 401);
  }
  const goUserId = userData.user.id;

  // 2) GO 侧身份链
  const goService = goClient(env, env.serviceKey);
  const { data: goLinkRow, error: goLinkErr } = await goService
    .from("erp_user_links")
    .select("*")
    .eq("user_id", goUserId)
    .maybeSingle();
  if (goLinkErr) throw new GoScopeError("go_identity_unavailable", "GO 身份链暂不可用", 503);
  const goLink = goLinkRow as Record<string, unknown> | null;
  const goLinkStatus = String(goLink?.["status"] ?? "").toLowerCase();
  const goErpUserId = (goLink?.["erp_user_id"] ?? null) as string | null;
  if (!goLink || !goErpUserId || (goLinkStatus && !["active", "approved"].includes(goLinkStatus))) {
    throw new GoScopeError("identity_not_linked", "该 GO 账号尚未与 ERP 账号绑定", 403);
  }

  // 3) ERP 侧身份链，双向核对同一个 ERP user id
  const { data: erpLinkRow, error: erpLinkErr } = await supabaseAdmin
    .from("go_identity_links" as never)
    .select("erp_user_id, status")
    .eq("go_project_ref", env.projectRef)
    .eq("go_user_id", goUserId)
    .maybeSingle();
  if (erpLinkErr) throw new GoScopeError("identity_unavailable", "身份登记暂不可用", 503);
  const erpLink = erpLinkRow as { erp_user_id: string | null; status: string } | null;
  if (!erpLink || erpLink.status !== "approved" || !erpLink.erp_user_id) {
    throw new GoScopeError("identity_not_approved", "该 GO 账号尚未在 ERP 审核通过", 403);
  }
  if (erpLink.erp_user_id !== goErpUserId) {
    throw new GoScopeError("identity_mismatch", "GO 与 ERP 的账号绑定不一致", 403);
  }
  const erpUserId = erpLink.erp_user_id;

  // 4) ERP 账号状态（停用 / 删除即拒绝）
  const { data: erpUser, error: erpUserErr } = await supabaseAdmin.auth.admin.getUserById(erpUserId);
  if (erpUserErr || !erpUser?.user) {
    throw new GoScopeError("erp_account_missing", "ERP 账号不存在", 403);
  }
  const u = erpUser.user as unknown as Record<string, unknown>;
  if (u["banned_until"] && new Date(String(u["banned_until"])).getTime() > now.getTime()) {
    throw new GoScopeError("erp_account_disabled", "ERP 账号已停用", 403);
  }
  if (u["deleted_at"]) throw new GoScopeError("erp_account_disabled", "ERP 账号已停用", 403);

  // 5) 当前角色（每次请求实时读取，不信任 token 里的声明）
  const { data: roleRows, error: roleErr } = await supabaseAdmin
    .from("user_roles" as never)
    .select("role")
    .eq("user_id", erpUserId);
  if (roleErr) throw new GoScopeError("roles_unavailable", "角色信息暂不可用", 503);
  const roles = ((roleRows as { role: string }[] | null) ?? []).map((r) => r.role);
  const isHq = roles.some((r) => HQ_ROLES.has(r));
  if (roles.length === 0) {
    throw new GoScopeError("no_erp_role", "该账号在 ERP 尚未配置角色", 403);
  }

  const today = shanghaiToday(now);
  const hqLocations = await loadRealShops();

  let scheduleState: ScheduleState = "no_schedule";
  let todayLocationId: string | null = null;
  const reasons: string[] = [];
  if (!isHq) {
    const sched = await resolveTodaySchedule(env, goService, goUserId, today);
    scheduleState = sched.state;
    todayLocationId = sched.locationId;
    reasons.push(...sched.reasons);
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
    schedule_state: isHq ? "scheduled" : scheduleState,
    today_location: todayLocationId
      ? {
          id: todayLocationId,
          name: hqLocations.find((l) => l.id === todayLocationId)?.name ?? "",
        }
      : null,
    hq_locations: hqLocations,
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

export type GoDailyStore = {
  location_id: string;
  name: string;
  target_fen: number | null;
  actual_fen: number | null;
  gap_fen: number | null;
  order_count: number | null;
  completeness: StoreCompleteness & {
    youzan_last_synced_at: string | null;
    offline_entry_count: number | null;
  };
};

export async function loadGoDailySummary(params: {
  actor: GoActor;
  scope: GoScope;
  date: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const nameOf = (id: string) =>
    params.actor.hq_locations.find((l) => l.id === id)?.name ?? "未知门店";

  const stores: GoDailyStore[] = [];
  for (const locationId of params.scope.locationIds) {
    try {
      const s = await loadDailySummary({ locationId, date: params.date, now });
      const complete = s.completeness.complete;
      const actual = complete || s.youzan.shop_bound ? s.achieved_fen : null;
      stores.push({
        location_id: locationId,
        name: nameOf(locationId),
        target_fen: s.target_fen,
        actual_fen: actual,
        gap_fen: gapFen(s.target_fen, actual),
        order_count:
          actual == null ? null : s.youzan.order_count + s.offline.order_count,
        completeness: {
          complete,
          // 本地没有有赞退款数据源 → 只能是已付款毛额口径
          kind: "paid_gross",
          reasons: s.completeness.reasons,
          youzan_last_synced_at: s.completeness.youzan_synced_through ?? null,
          offline_entry_count: s.offline.entry_count,
        },
      });
    } catch (e) {
      stores.push({
        location_id: locationId,
        name: nameOf(locationId),
        target_fen: null,
        actual_fen: null,
        gap_fen: null,
        order_count: null,
        completeness: {
          complete: false,
          kind: "paid_gross",
          reasons: ["store_summary_failed", (e as Error).message],
          youzan_last_synced_at: null,
          offline_entry_count: null,
        },
      });
    }
  }

  const totalsTarget = sumNullable(stores.map((s) => s.target_fen));
  const totalsActual = sumNullable(stores.map((s) => s.actual_fen));
  const merged = mergeCompleteness(
    stores.map((s) => ({
      complete: s.completeness.complete,
      kind: s.completeness.kind,
      reasons: s.completeness.reasons,
    })),
  );

  return {
    date: params.date,
    scope: {
      mode: params.scope.mode,
      location_ids: params.scope.locationIds,
      today_location_id: params.scope.todayLocationId,
    },
    totals: {
      target_fen: totalsTarget,
      actual_fen: totalsActual,
      gap_fen: gapFen(totalsTarget, totalsActual),
      order_count: sumNullable(stores.map((s) => s.order_count)),
      store_count: stores.length,
    },
    stores,
    completeness: merged,
    generated_at: now.toISOString(),
  };
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
