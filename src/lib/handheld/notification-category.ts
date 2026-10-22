// 通知 kind → 类别映射。必须与 DB 函数 handheld_notification_category(text) 保持一致：
// 该 SQL 函数是唯一权威，这里是服务端过滤列表用的同规则 TS 端口；
// 语料测试见 notification-category.test.ts 与 supabase/tests/handheld_todo_notification_fixes.sql。
export const NOTIFICATION_CATEGORIES = ["customers", "internal", "orders", "system"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

const CUSTOMERS = ["customer", "conversation", "support", "inquiry", "measurement"];
const ORDERS = ["order", "refund", "fulfillment", "shipment", "shortage", "pickup"];
const INTERNAL = ["internal", "announcement", "transfer", "stocktake"];

function matchesPrefix(normalized: string, prefix: string): boolean {
  return normalized === prefix || normalized.startsWith(`${prefix}_`);
}

export function notificationKindCategory(kind: string | null | undefined): NotificationCategory {
  const v = (kind ?? "").toLowerCase().replace(/[.-]/g, "_");
  if (CUSTOMERS.some((p) => matchesPrefix(v, p))) return "customers";
  if (ORDERS.some((p) => matchesPrefix(v, p))) return "orders";
  if (INTERNAL.some((p) => matchesPrefix(v, p))) return "internal";
  return "system";
}

export function isNotificationCategory(raw: string): raw is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(raw);
}
