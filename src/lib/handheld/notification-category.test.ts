// 通知 kind → 类别映射：必须与 DB handheld_notification_category(text) 完全一致。
// 语料与 supabase/tests/handheld_todo_notification_fixes.sql 的 SQL 断言一一对应。
import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationKindCategory, NOTIFICATION_CATEGORIES } from "./notification-category";

test("category corpus matches DB prefix rules", () => {
  const cases: Array<[string, string]> = [
    ["order_paid", "orders"],
    ["fulfillment_exception", "orders"],
    ["pickup_ready", "orders"],
    ["refund_pending", "orders"],
    ["shortage_reported", "orders"],
    ["shipment_delivered", "orders"],
    ["measurement_requested", "customers"],
    ["support_escalation", "customers"],
    ["customer_message", "customers"],
    ["conversation_assigned", "customers"],
    ["inquiry_new", "customers"],
    ["transfer_out", "internal"],
    ["stocktake_opened", "internal"],
    ["internal_note", "internal"],
    ["announcement_all", "internal"],
    ["stock_sync_failed", "system"],
    ["channel_sync_failed", "system"],
    ["system_notice", "system"],
    ["totally_unknown_kind", "system"],
  ];
  for (const [kind, expected] of cases) {
    assert.equal(notificationKindCategory(kind), expected, `kind=${kind}`);
  }
});

test("normalization: lower-case and . / - fold to _", () => {
  assert.equal(notificationKindCategory("Order.Paid"), "orders");
  assert.equal(notificationKindCategory("MEASUREMENT-REQUESTED"), "customers");
  assert.equal(notificationKindCategory("Stock_Sync_Failed"), "system");
});

test("prefix boundary: 'stock' alone is not internal, 'stocktake_x' is", () => {
  assert.equal(notificationKindCategory("stock"), "system");
  assert.equal(notificationKindCategory("stocktake"), "internal");
  assert.equal(notificationKindCategory("stocktake_submitted", "stocktake"), "internal");
});

test("category enum is exactly the four buckets", () => {
  assert.deepEqual([...NOTIFICATION_CATEGORIES].sort(), ["customers", "internal", "orders", "system"]);
});
