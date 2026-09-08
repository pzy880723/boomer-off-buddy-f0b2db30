/**
 * 消费 GO 侧 `erp_verify_current_scope_v1()`（**无参数**）的返回值（纯逻辑，可单测）。
 *
 * 真实契约（GO b9eaad54）：
 * {
 *   authenticated: true,
 *   user_id: <GO auth uid>,
 *   erp_user_id: <可信 ERP uuid>,
 *   is_erp_user: true,
 *   scope_context: { scope: 'hq'|'store'|'unconfigured', shop_ids: [], role_codes: [],
 *                    erp_linked: bool, erp_governed: bool, reason?: string },
 *   shop_context:  { date: 'yyyy-mm-dd', scope, status: 'hq'|'scheduled'|'rest'|'unscheduled'|'unconfigured',
 *                    effective_shop: {id,name}|null, authorized_shops: [{id,name}], self_schedule }
 * }
 *
 * 铁律：
 *  - 严格按上面的嵌套结构解析，不做任何平铺字段/别名兼容猜测。
 *  - 唯一可信身份是 erp_user_id；不得按 email / 手机号 / 姓名猜。
 *  - 日期缺失绝不默认今天；跨日 409；GO 与 ERP scope 不一致 → 上下文过期待刷新（409）。
 *  - rest / unscheduled / unconfigured 三者严格区分，绝不互相降级。
 */
import { GoScopeError, type ScheduleState } from "./scope";

export type GoShopRef = { id: string; name: string | null };

export type GoVerifiedScope = {
  goUserId: string;
  erpUserId: string;
  scope: "hq" | "store";
  roleCodes: string[];
  erpLinked: boolean;
  erpGoverned: boolean;
  date: string;
  status: "hq" | "scheduled" | "rest" | "unscheduled";
  scheduleState: ScheduleState;
  effectiveShop: GoShopRef | null;
  authorizedShops: GoShopRef[];
  reasons: string[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function unavailable(detail: string): never {
  throw new GoScopeError("go_scope_unavailable", `GO 身份/排班上下文不可用（${detail}）`, 503);
}

function shopRef(v: unknown): GoShopRef | null {
  const o = obj(v);
  if (!o) return null;
  const id = str(o["id"]);
  if (!id) return null;
  return { id, name: str(o["name"]) };
}

export function parseGoVerifyPayload(
  raw: unknown,
  opts: { expectedDate: string; expectedGoUserId: string },
): GoVerifiedScope {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const root = obj(first);
  if (!root) unavailable("payload");

  if (typeof root["authenticated"] !== "boolean") unavailable("authenticated");
  if (root["authenticated"] !== true) {
    throw new GoScopeError("invalid_go_token", "GO 访问令牌无效或已过期", 401);
  }

  const goUserId = str(root["user_id"]);
  if (!goUserId || goUserId !== opts.expectedGoUserId) {
    throw new GoScopeError("go_identity_mismatch", "GO 身份与访问令牌不一致", 403);
  }

  if (root["is_erp_user"] !== true) {
    throw new GoScopeError("go_identity_not_linked", "该 GO 账号尚未绑定 ERP 账号", 403);
  }
  // erp_user_id 是唯一可信的 ERP 身份来源（GO erp_user_links.aigc_user_id = auth.uid()）。
  // 缺失/非 UUID 一律 fail closed：绝不退回 email / 手机号 / user_metadata 猜 ID。
  const erpUserId = str(root["erp_user_id"]);
  if (!erpUserId || !UUID_RE.test(erpUserId)) {
    throw new GoScopeError(
      "go_erp_user_id_unavailable",
      "GO 尚未返回可信的 ERP 用户 ID，无法确认权限",
      503,
    );
  }

  const scopeCtx = obj(root["scope_context"]);
  const shopCtx = obj(root["shop_context"]);
  if (!scopeCtx || !shopCtx) unavailable("context");

  const scopeRaw = str(scopeCtx["scope"]);
  if (scopeRaw !== "hq" && scopeRaw !== "store" && scopeRaw !== "unconfigured") {
    unavailable("scope");
  }
  if (scopeRaw === "unconfigured") {
    throw new GoScopeError("go_scope_unconfigured", "该账号在 GO 尚未配置范围", 403);
  }
  const scope: "hq" | "store" = scopeRaw;

  const date = str(shopCtx["date"]);
  if (!date || !DATE_RE.test(date)) unavailable("date");
  if (date !== opts.expectedDate) {
    throw new GoScopeError("go_scope_date_mismatch", "GO 与 ERP 的业务日期不一致", 409);
  }

  const shopScope = str(shopCtx["scope"]);
  if (shopScope !== scope) {
    throw new GoScopeError("go_scope_stale", "GO 范围上下文已过期，请刷新后重试", 409);
  }

  const statusRaw = str(shopCtx["status"]);
  if (statusRaw === "unconfigured") {
    throw new GoScopeError("go_scope_unconfigured", "该账号在 GO 尚未配置门店范围", 403);
  }
  if (
    statusRaw !== "hq" &&
    statusRaw !== "scheduled" &&
    statusRaw !== "rest" &&
    statusRaw !== "unscheduled"
  ) {
    unavailable("status");
  }
  if ((statusRaw === "hq") !== (scope === "hq")) {
    throw new GoScopeError("go_scope_stale", "GO 范围上下文已过期，请刷新后重试", 409);
  }

  const effectiveShop = shopRef(shopCtx["effective_shop"]);
  const authorizedShops = Array.isArray(shopCtx["authorized_shops"])
    ? (shopCtx["authorized_shops"] as unknown[]).map(shopRef).filter((s): s is GoShopRef => !!s)
    : [];

  const scheduleState: ScheduleState =
    statusRaw === "hq" || statusRaw === "scheduled"
      ? "scheduled"
      : statusRaw === "rest"
        ? "off"
        : "no_schedule";

  if (statusRaw === "scheduled" && !effectiveShop) {
    throw new GoScopeError("go_schedule_missing_shop", "GO 排班未给出当天门店", 503);
  }

  const roleCodes = Array.isArray(scopeCtx["role_codes"])
    ? (scopeCtx["role_codes"] as unknown[]).map(str).filter((s): s is string => !!s)
    : [];

  const reasons: string[] = [];
  const reason = str(scopeCtx["reason"]);
  if (reason) reasons.push(`go:${reason}`);

  return {
    goUserId,
    erpUserId,
    scope,
    roleCodes,
    erpLinked: scopeCtx["erp_linked"] === true,
    erpGoverned: scopeCtx["erp_governed"] === true,
    date,
    status: statusRaw,
    scheduleState,
    effectiveShop: statusRaw === "scheduled" ? effectiveShop : null,
    authorizedShops,
    reasons,
  };
}

export type GoShopMapping = { location_id: string; status: string } | null;

/** GO shop id → ERP inv_locations.id，只走显式 active 映射，不按名字/电话猜 */
export function resolveErpStoreLocation(input: {
  goShopId: string;
  mapping: GoShopMapping;
  activeShopIds: string[];
  permittedLocationIds: string[];
}): string {
  const mapping = input.mapping;
  if (!mapping || mapping.status !== "active" || !mapping.location_id) {
    throw new GoScopeError("shop_mapping_unconfigured", "该门店尚未在 ERP 完成映射", 503);
  }
  if (!input.activeShopIds.includes(mapping.location_id)) {
    throw new GoScopeError("location_inactive", "该门店已停用", 403);
  }
  if (!input.permittedLocationIds.includes(mapping.location_id)) {
    throw new GoScopeError("location_permission_revoked", "该账号没有此门店的查看权限", 403);
  }
  return mapping.location_id;
}
