import { expect, mock, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";

// 真实 supabase-js + 捕获 URL：断言队列/搜索/门店过滤都在数据库查询（limit 之前）完成。
const urls = [];
const admin = createClient("https://t.supabase.co", "k", {
  global: { fetch: async (u) => { urls.push(decodeURIComponent(String(u))); return new Response("[]", { status: 200, headers: { "content-type": "application/json" } }); } },
});
mock.module("@/integrations/supabase/client.server", () => ({ supabaseAdmin: admin }));
const { listStaffConversations } = await import("@/server/support.server");
const LA = "5c000000-0000-4000-8000-00000000000a";
const staff = { user_id: "u1", display_name: "x", is_hq_agent: false, location_ids: [LA], participant_role: "store_agent" };
const conv = () => urls.filter((u) => u.includes("/support_conversations")).at(-1);

test("queue 映射为数据库过滤，且门店员工只看本店", async () => {
  await listStaffConversations({ access: staff, queue: "unclaimed" });
  expect(conv()).toContain(`location_id=in.(${LA})`);
  expect(conv()).toContain("status=in.(open,pending)");
  expect(conv()).toContain("primary_agent_id=is.null");
  await listStaffConversations({ access: staff, queue: "mine" });
  expect(conv()).toContain("primary_agent_id=eq.u1");
  await listStaffConversations({ access: staff, queue: "escalated" });
  expect(conv()).toContain("escalated_at=not.is.null");
  await listStaffConversations({ access: staff, queue: "closed" });
  expect(conv()).toContain("status=eq.closed");
});

test("旧 status 合约保留；总部无门店限制；无门店员工直接空结果", async () => {
  await listStaffConversations({ access: staff, status: "open" });
  expect(conv()).toContain("status=eq.open");
  await listStaffConversations({ access: { ...staff, is_hq_agent: true, location_ids: [] }, queue: "all" });
  expect(conv()).not.toContain("location_id=in.");
  const before = urls.length;
  const r = await listStaffConversations({ access: { ...staff, location_ids: [] }, queue: "all" });
  expect(r.items).toEqual([]); expect(urls.length).toBe(before);
});

test("搜索词与游标同时作为数据库 or 条件，分页 limit+1 不在内存裁剪", async () => {
  await listStaffConversations({ access: staff, queue: "all", q: "BO2026" });
  const u = conv();
  expect(u).toContain("title.ilike.*BO2026*");
  expect(u).toContain("limit=31");
  expect(u).toContain(`location_id=in.(${LA})`);
});
