// 原生前后台提醒判定（纯函数，可单测）。只有"未读 + 未处理/未作废/未暂停"的
// 付款订单与尺寸测量申请需要语音/锁屏提醒；客户端按通知 id 去重播报。
// 不代表已推送：服务端只给出判定，系统推送需另行配置提供商。
export const ALERT_KINDS = ["order_paid", "measurement_requested"] as const;

export type AlertRow = {
  kind: string;
  is_read: boolean;
  action_status: string | null;
  ref_type: string | null;
  ref_id: string | null;
  payload: Record<string, unknown>;
};

export function alertFields(row: AlertRow): {
  should_alert: boolean;
  alert_kind: (typeof ALERT_KINDS)[number] | null;
  measurement_task_id: string | null;
  sku_id: string | null;
} {
  const kind = (ALERT_KINDS as readonly string[]).includes(row.kind)
    ? (row.kind as (typeof ALERT_KINDS)[number])
    : null;
  const isMeasurement = row.kind === "measurement_requested" && row.ref_type === "measurement_task";
  const sku = row.payload?.["sku_id"];
  return {
    should_alert: kind !== null && !row.is_read && row.action_status === null,
    alert_kind: kind,
    measurement_task_id: isMeasurement ? row.ref_id : null,
    sku_id: isMeasurement && typeof sku === "string" ? sku : null,
  };
}
