import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync("src/routes/admin.channel-sync.tsx", "utf8");

test("真实同步异常页不直接渲染内部状态、渠道、动作或 UUID", () => {
  for (const raw of ["{s}", "{r.status}", "{r.action}", "{r.channel}", "{r.source_channel}", "{r.event_type}", "{r.sku_id ??", "?? r.sku_id", "{r.last_error ??", "{r.error ??"]) {
    assert.equal(page.includes(raw), false, `仍直接渲染 ${raw}`);
  }
  assert.doesNotMatch(page, /description="[^"]*(channel_sync_outbox|inventory_sale_events)/);
  assert.doesNotMatch(page, /<TableHead>SKU<\/TableHead>/);
});

test("真实页面使用共用中文映射及错误呈现，保留订单号与原操作", () => {
  for (const helper of ["syncStatusLabel", "syncActionLabel", "syncChannelLabel", "saleEventLabel", "productDisplay", "errorLabel", "nextAction"]) {
    assert.match(page, new RegExp(`\\b${helper}\\(`));
  }
  assert.ok(page.includes("{r.source_order_id}"));
  assert.ok(page.includes("retry.mutate(r.id)"));
  assert.ok(page.includes("dismiss.mutate(r.id)"));
  assert.ok(page.includes('queryKey: ["outbox", status]'));
  assert.ok(page.includes('queryKey: ["sale-events", status]'));
});