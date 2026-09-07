/**
 * 消费 GO 侧 `erp_verify_current_scope_v1` 的返回值（纯逻辑，可单测）。
 *
 * 铁律：
 *  - 唯一可信身份是 GO RPC 返回的 erp_user_id；不得按 email / 手机号 / 姓名猜。
 *  - 排班三态（scheduled / off / no_schedule）必须由 GO 显式给出；
 *    GO 既没给状态也没给门店时一律 unavailable，绝不擅自当成"没排班"。
 *  - 当天门店必须同时满足：可信映射 → ERP 真实启用门店 → 该用户仍有门店权限。
 *    任一不满足即拒绝，撤销权限即时生效。
 */
import { GoScopeError, type ScheduleState } from "./scope";

export type GoVerifiedScope = {
  erpUserId: string;
  date: string;
  scope: "hq" | "store";
  scheduleState: ScheduleState;
  goShopId: string | null;
  reasons: string[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function pickShopId(row: Record<string, unknown>): string | null {
  const nested = row["effective_shop"];
  if (nested && typeof nested === "object") {
    const n = nested as Record<string, unknown>;
    const id = str(n["id"]) ?? str(n["shop_id"]) ?? str(n["go_shop_id"]);
    if (id) return id;
  }
  return (
    str(row["effective_shop_id"]) ??
    str(row["shop_id"]) ??
    str(row["today_shop_id"]) ??
    str(row["go_shop_id"])
  );
}

function pickScheduleState(raw: string | null): ScheduleState | null {
  switch ((raw ?? "").toLowerCase()) {
    case "scheduled":
    case "on_duty":
    case "working":
      return "scheduled";
    case "off":
    case "rest":
    case "leave":
    case "day_off":
      return "off";
    case "no_schedule":
    case "unscheduled":
    case "none":
      return "no_schedule";
    case "unavailable":
    case "unknown":
      return "unavailable";
    default:
      return null;
  }
}

export function normalizeGoVerifyPayload(raw: unknown, expectedDate: string): GoVerifiedScope {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first || typeof first !== "object") {
    throw new GoScopeError("go_scope_unavailable", "GO 身份/排班服务暂时不可用", 503);
  }
  const row = first as Record<string, unknown>;

  const erpUserId = str(row["erp_user_id"]);
  if (!erpUserId || !UUID_RE.test(erpUserId)) {
    throw new GoScopeError("go_identity_not_linked", "该 GO 账号尚未绑定 ERP 账号", 403);
  }

  const date = str(row["today"]) ?? str(row["work_date"]) ?? str(row["date"]);
  if (date && date !== expectedDate) {
    throw new GoScopeError("go_scope_date_mismatch", "GO 与 ERP 的业务日期不一致", 409);
  }

  const scopeRaw = (str(row["scope"]) ?? str(row["role_scope"]) ?? "store").toLowerCase();
  const scope: "hq" | "store" = scopeRaw === "hq" ? "hq" : "store";

  const reasons: string[] = [];
  const goShopId = pickShopId(row);
  const explicit = pickScheduleState(
    str(row["schedule_state"]) ?? str(row["shift_state"]) ?? str(row["state"]),
  );

  let scheduleState: ScheduleState;
  if (scope === "hq") {
    scheduleState = "scheduled";
  } else if (explicit) {
    scheduleState = explicit;
  } else if (goShopId) {
    scheduleState = "scheduled";
  } else {
    scheduleState = "unavailable";
    reasons.push("go_schedule_state_unknown");
  }

  if (scheduleState === "scheduled" && scope === "store" && !goShopId) {
    scheduleState = "unavailable";
    reasons.push("go_schedule_missing_shop");
  }

  return {
    erpUserId,
    date: date ?? expectedDate,
    scope,
    scheduleState,
    goShopId: scheduleState === "scheduled" ? goShopId : null,
    reasons,
  };
}

export type GoShopMapping = { location_id: string; status: string } | null;

export function resolveErpStoreLocation(input: {
  goShopId: string;
  mapping: GoShopMapping;
  activeShopIds: string[];
  permittedLocationIds: string[];
}): string {
  const mapping = input.mapping;
  if (!mapping || mapping.status !== "active" || !mapping.location_id) {
    throw new GoScopeError("shop_mapping_missing", "该门店尚未在 ERP 完成映射", 503);
  }
  if (!input.activeShopIds.includes(mapping.location_id)) {
    throw new GoScopeError("location_inactive", "该门店已停用", 403);
  }
  if (!input.permittedLocationIds.includes(mapping.location_id)) {
    throw new GoScopeError("location_permission_revoked", "该账号没有此门店的查看权限", 403);
  }
  return mapping.location_id;
}
