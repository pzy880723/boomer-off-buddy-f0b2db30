import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { customerServiceName, toCustomerConversationListItem, CUSTOMER_LIST_FIELDS } from "./support-customer-dto.ts";

test("service_name: null location is HQ; real location uses its name; missing/blank location never claims HQ", () => {
  const locs = new Map([["L1", { name: "新天地店" }], ["L2", { name: "  " }]]);
  assert.equal(customerServiceName(null, locs), "总部客服");
  assert.equal(customerServiceName("L1", locs), "新天地店客服");
  assert.equal(customerServiceName("L2", locs), "门店客服");
  assert.equal(customerServiceName("GONE", locs), "门店客服");
});

test("list item is a whitelist: safe context only, no internal/staff/contact fields", () => {
  const item = toCustomerConversationListItem({
    id: "c1", title: "咨询", status: "open", location_id: "L1", order_id: "o1",
    last_message_at: "2026-10-13T00:00:00Z", last_message_preview: "你好", updated_at: "2026-10-13T00:00:01Z",
    customer_id: "cust", primary_agent_id: "staff-uuid", escalation_reason: "内部备注",
    context: { type: "product", id: "p1", title: "Hello Kitty橘色挂件", sku_code: "S1", price: 39,
      image_url: "https://signed/secret", note: "内部", staff_email: "a@b.c", phone: "13800000000", nested: { x: 1 } },
  }, new Map([["L1", { name: "新天地店" }]]));
  assert.deepEqual(Object.keys(item).sort(), [...CUSTOMER_LIST_FIELDS].sort());
  assert.equal(item.service_name, "新天地店客服");
  assert.deepEqual(item.context, { type: "product", id: "p1", title: "Hello Kitty橘色挂件", sku_code: "S1", price: 39 });
  const json = JSON.stringify(item);
  for (const leak of ["staff-uuid", "内部", "a@b.c", "13800000000", "signed/secret", "cust"]) assert.ok(!json.includes(leak), leak);
});

test("order context keeps order_no; empty context is null", () => {
  const it = toCustomerConversationListItem({ id: "c", location_id: null, context: { type: "order", id: "o", order_no: "BO123" } }, new Map());
  assert.deepEqual(it.context, { type: "order", id: "o", order_no: "BO123" });
  assert.equal(it.service_name, "总部客服");
  assert.equal(toCustomerConversationListItem({ id: "c", location_id: null, context: null }, new Map()).context, null);
});

test("server: list filters by customer first, batches location names, detail adds service_name", () => {
  const src = readFileSync(new URL("../server/support.server.ts", import.meta.url), "utf8");
  const list = src.slice(src.indexOf("export async function listCustomerConversations"), src.indexOf("export async function ensureCustomerConversation"));
  assert.match(list, /\.eq\("customer_id", customerId\)/);
  assert.match(list, /\.in\("id", locationIds\)/);
  assert.match(list, /toCustomerConversationListItem/);
  const detail = src.slice(src.indexOf("export async function getCustomerConversation"), src.indexOf("export async function postCustomerMessage"));
  assert.ok(detail.indexOf("conversation.customer_id !== customerId") < detail.indexOf("service_name"));
  assert.match(detail, /service_name: customerServiceName/);
});
