// 同步中心：范围解析与中文展示（纯函数，便于测试）。内部字段原样保留，中文仅作展示。
import type { NotificationScope } from "@/server/handheld-notifications.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LocationRow = { id: string; name: string; kind: "warehouse" | "shop"; shop_id: string | null };

/**
 * 有效库位 = 显式 location_id（须在授权内）否则设备当前库位。
 * 只有总部账号 + 总部仓位可看全部授权库位；其余（含总部账号切到门店）只看本库位。
 */
export function resolveSyncLocations(
  scope: NotificationScope,
  requested: string | null | undefined,
  kindOf: (id: string) => LocationRow["kind"] | null,
): { ok: true; locationIds: string[]; current: string } | { ok: false; status: number; code: string } {
  const raw = (requested ?? "").trim();
  let current: string | null;
  if (raw) {
    if (!UUID.test(raw)) return { ok: false, status: 400, code: "validation_error" };
    const v = raw.toLowerCase();
    if (!scope.location_ids.includes(v)) return { ok: false, status: 403, code: "location_forbidden" };
    current = v;
  } else {
    current = scope.device_location_id;
  }
  if (!current) return { ok: false, status: 400, code: "location_required" };
  const kind = kindOf(current);
  if (!kind) return { ok: false, status: 403, code: "location_forbidden" };
  if (scope.is_hq && kind === "warehouse") return { ok: true, locationIds: [...scope.location_ids], current };
  return { ok: true, locationIds: [current], current };
}

export { statusLabel, reasonLabel, nextAction } from "@/lib/sync-record-labels";
