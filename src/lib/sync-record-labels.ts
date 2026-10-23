// 同步任务中文展示（手机同步中心与 PC 同步中心共用）。done 只代表任务结束，不代表已读回有赞库存。
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
      return "任务已结束；若有赞库存仍异常，请总部核对";
    default:
      return "请联系总部确认";
  }
}

/** 失败原因中文呈现；原 last_error 字段保留不改。 */
export function errorLabel(lastError: string | null | undefined): string | null {
  const e = lastError?.trim();
  if (!e) return null;
  if (/进出存|进销存/.test(e)) return "门店开启了库存单管理，需库存单核对";
  if (/尚未发布|未发布到/.test(e)) return "商品尚未发布到该门店，请先等发布完成";
  return "同步出错，请总部核对技术记录";
}
