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

const STATUS_LABELS: Record<string, string> = {
  pending: "等待同步",
  running: "同步中",
  processing: "同步中",
  done: "同步任务已结束",
  failed: "同步失败",
  dead_letter: "多次失败已停止",
  superseded: "已被新任务替代",
  cancelled: "已取消",
};

const REASON_LABELS: Record<string, string> = {
  offline_product_release: "商品发布到门店",
  meiluo_standard_warehouse_verified: "美罗城标准商品库存单核对",
  "sale:youzan_branch_offline": "门店线下售出",
  handheld_item_deleted: "手机端删除商品",
  superseded_by_item_delete: "商品删除后取消旧任务",
  handheld_restock: "手机端补货",
  duplicate_listing_reversed: "撤回重复上架",
  pos_sale: "收银售出",
  commerce_sale: "商城售出",
  handheld_smart_create: "拍照上架",
};

export function statusLabel(status: string | null | undefined): string {
  return (status && STATUS_LABELS[status]) || "状态未知";
}

export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return "其他同步";
  if (REASON_LABELS[reason]) return REASON_LABELS[reason];
  if (reason.startsWith("sale:")) return "售出后同步";
  return "其他同步";
}

/** done 只代表任务已结束，不代表已读回有赞库存。 */
export function nextAction(status: string | null | undefined): string {
  switch (status) {
    case "pending":
    case "running":
    case "processing":
      return "系统会自动处理，无需操作";
    case "failed":
      return "系统会自动重试；多次仍失败请联系总部";
    case "dead_letter":
      return "已停止自动重试，请联系总部处理";
    case "done":
      return "无需操作";
    default:
      return "请联系总部确认";
  }
}
