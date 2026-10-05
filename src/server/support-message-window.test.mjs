// 行为/契约测试：门店一致性、同时间稳定游标、after 排空、is_mine 安全、旧 API 兼容、头像缓存。
// 全部合成数据 + 内存模拟，不连真实库。
import { beforeEach, expect, mock, test } from "bun:test";
import {
  parseMessageWindow,
  shapeMessageWindow,
  assertConversationLocation,
  sanitizeSupportSearch,
  encodeMessageCursor,
} from "@/lib/support-message-window";

const queries = [];
let authCalls = [];
let rpcCalls = 0;
const rpcLog = [];
let locationId = "11111111-1111-4111-8111-111111111111";
const OTHER_LOC = "22222222-2222-4222-8222-222222222222";
const SAME_TS = "2026-10-05T12:00:00.000000+00:00";
// 120 条消息：前 60 条完全相同时间戳，只靠 id 区分
const messages = Array.from({ length: 120 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  sender_type: i % 3 === 0 ? "customer" : "staff",
  sender_customer_id: i % 3 === 0 ? "customer-a" : null,
  sender_user_id: i % 3 === 0 ? null : i % 2 ? "me" : "hq-one",
  sender_name: i % 3 === 0 ? "顾客" : "staff@example.com",
  body: `m${i}`,
  internal: i % 7 === 0 && i % 3 !== 0,
  delivery_status: "sent",
  created_at: i < 60 ? SAME_TS : `2026-10-05T13:${String(i - 60).padStart(2, "0")}:00.000000+00:00`,
}));
const key = (m) => `${m.created_at}|${m.id}`;
const cmp = (a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.created_at < b.created_at ? -1 : 1);

mock.module("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table) {
      const q = { table, columns: "", filters: [], or: [], asc: true, limit: 1e9 };
      queries.push(q);
      const chain = {
        select(c) { q.columns = c; return chain; },
        eq(k, v) { q.filters.push([k, v]); return chain; },
        in(k, v) { q.filters.push([k, v]); return chain; },
        gt() { return chain; },
        or(s) { q.or.push(s); return chain; },
        order(_c, o) { q.asc = o?.ascending !== false; return chain; },
        limit(n) { q.limit = n; return chain; },
        upsert() { q.upsert = true; return Promise.resolve({ error: null }); },
        maybeSingle() { return Promise.resolve(single()); },
        then(r) { return Promise.resolve(result()).then(r); },
      };
      function single() {
        const r = result();
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
      }
      function result() {
        if (table === "support_conversations")
          return { data: { id: "conv-a", customer_id: "customer-a", location_id: locationId, primary_agent_id: "me", status: "open", channel: "native", assignment_version: 3 }, error: null };
        if (table === "support_messages") {
          let rows = messages.filter((m) => q.filters.every(([k, v]) => k === "conversation_id" || m[k] === v));
          for (const s of q.or) {
            const m = /^created_at\.(lt|gt)\."([^"]+)",and\(created_at\.eq\."[^"]+",id\.(?:lt|gt)\.([0-9a-f-]+)\)$/.exec(s);
            if (!m) continue;
            const c = { created_at: m[2], id: m[3] };
            rows = rows.filter((r) => (m[1] === "lt" ? cmp(r, c) < 0 : cmp(r, c) > 0));
          }
          rows.sort((a, b) => (q.asc ? cmp(a, b) : cmp(b, a)));
          return { data: rows.slice(0, q.limit), error: null, count: 0 };
        }
        if (table === "support_participants")
          return { data: [
            { conversation_id: "conv-a", user_id: "me", participant_role: "store_staff", display_name: "我" },
            { conversation_id: "conv-a", user_id: "hq-one", participant_role: "hq_agent", display_name: "总部" },
          ], error: null };
        if (table === "commerce_customers") return { data: [{ id: "customer-a", nickname: "顾客", avatar_url: null }], error: null };
        if (table === "inv_locations") return { data: [{ id: locationId, name: "A店", shop_id: null }], error: null };
        return { data: [], error: null };
      }
      return chain;
    },
    auth: { admin: { async getUserById(id) { authCalls.push(id); return { data: { user: { app_metadata: {}, user_metadata: { name: id } } }, error: null }; } } },
    async rpc(fn, args) {
      rpcLog.push([fn, args]);
      if (fn === "support_conversation_stats") return { data: args.p_conversation_ids.map((id) => ({ conversation_id: id, unread_count: "7", last_customer_message_at: SAME_TS })), error: null };
      if (fn === "support_mark_read") return { data: args.p_read_at, error: null };
      rpcCalls++;
      return { data: { ok: true, message: messages[1] }, error: null };
    },
  },
}));
mock.module("@/server/handheld-auth.server", () => ({ loadUserRoles: async () => [] }));
const { getStaffConversation, getCustomerConversation, postStaffMessage, updateConversationAssignment } =
  await import("@/server/support.server");

const staff = { user_id: "me", display_name: "我", is_hq_agent: false, location_ids: [locationId], participant_role: "store_staff" };
const hq = { user_id: "hq-one", display_name: "总部", is_hq_agent: true, location_ids: [], participant_role: "hq_agent" };
const win = (p) => { const r = parseMessageWindow(p); if (!r.ok) throw new Error(r.code); return r.window; };

beforeEach(() => { rpcLog.length = 0; queries.length = 0; authCalls = []; rpcCalls = 0; locationId = "11111111-1111-4111-8111-111111111111"; });

test("参数解析：before/after 互斥、limit 越界、非法游标、旧客户端默认 500", () => {
  expect(parseMessageWindow({ before: `${SAME_TS}|${messages[0].id}`, after: `${SAME_TS}|${messages[0].id}` })).toEqual({ ok: false, code: "cursor_conflict" });
  expect(parseMessageWindow({ limit: "0" })).toEqual({ ok: false, code: "invalid_limit" });
  expect(parseMessageWindow({ limit: "101" })).toEqual({ ok: false, code: "invalid_limit" });
  expect(parseMessageWindow({ before: "nope" })).toEqual({ ok: false, code: "invalid_cursor" });
  expect(win({})).toEqual({ mode: "latest", limit: 500, legacy: true });
  expect(win({ limit: "50" })).toEqual({ mode: "latest", limit: 50, legacy: false });
});

test("门店一致性：提供 location_id 时必须等于会话门店", () => {
  expect(assertConversationLocation("a", null)).toEqual({ ok: true });
  expect(assertConversationLocation("a", "a")).toEqual({ ok: true });
  expect(assertConversationLocation("a", "b")).toEqual({ ok: false, code: "location_mismatch" });
  expect(assertConversationLocation(null, "b")).toEqual({ ok: false, code: "location_mismatch" });
});

test("搜索词：<=80 字，去掉过滤语法字符", () => {
  expect(sanitizeSupportSearch("x".repeat(81))).toEqual({ ok: false, code: "invalid_query" });
  expect(sanitizeSupportSearch(" BO2026,(x)* ")).toEqual({ ok: true, q: "BO2026 x" });
  expect(sanitizeSupportSearch("   ")).toEqual({ ok: true, q: null });
});

test("跨店拒绝：总部带当前门店 location_id 也读不到另一店，且在消息/头像查询前拒绝", async () => {
  const r = await getStaffConversation(hq, "conv-a", { locationId: OTHER_LOC, window: win({ limit: 50 }) });
  expect(r).toEqual({ ok: false, code: "location_mismatch" });
  expect(queries.map((q) => q.table)).toEqual(["support_conversations"]);
  expect(authCalls).toEqual([]);
});

test("跨店拒绝：POST 回复与 assignment 在错误库位不写入", async () => {
  const p = await postStaffMessage({ access: hq, conversationId: "conv-a", body: "x", internal: true, clientOpId: "op", locationId: OTHER_LOC });
  expect(p.ok).toBe(false);
  expect(p.code).toBe("location_mismatch");
  const a = await updateConversationAssignment({ access: hq, conversationId: "conv-a", action: "takeover", assignmentVersion: 3, locationId: OTHER_LOC });
  expect(a.ok).toBe(false);
  expect(a.code).toBe("location_mismatch");
  expect(rpcCalls).toBe(0);
});

test("不传 location_id 的总部网页能力保留", async () => {
  const r = await getStaffConversation(hq, "conv-a");
  expect(r.ok).toBe(true);
  expect(r.data.messages.length).toBe(120);
  expect(r.data.has_more).toBe(false);
});

test("首次 50 条 + 向上翻页：同时间戳不重复不遗漏，正序返回", async () => {
  const seen = [];
  let r = await getStaffConversation(staff, "conv-a", { locationId, window: win({ limit: 50 }) });
  const latest = r.data.latest_cursor;
  expect(latest).toBe(key(messages[119]));
  seen.unshift(...r.data.messages.map((m) => m.id));
  while (r.data.has_more) {
    const before = r.data.older_cursor;
    r = await getStaffConversation(staff, "conv-a", { locationId, window: win({ limit: 50, before }) });
    expect(r.data.latest_cursor).toBeNull(); // 历史翻页不提供水位，不能覆盖增量游标
    expect(r.data.has_newer).toBe(false);
    seen.unshift(...r.data.messages.map((m) => m.id));
  }
  expect(seen).toEqual(messages.map((m) => m.id));
  expect(new Set(seen).size).toBe(120);
});

test("after 排空：从同时间戳中间开始，取最早的新 50 条，has_newer 指示继续，无结果回传请求游标", async () => {
  let cursor = key(messages[9]);
  const got = [];
  for (;;) {
    const r = await getStaffConversation(staff, "conv-a", { window: win({ limit: 50, after: cursor }) });
    got.push(...r.data.messages.map((m) => m.id));
    expect(r.data.has_more).toBe(false);
    cursor = r.data.latest_cursor;
    if (!r.data.has_newer) break;
  }
  expect(got).toEqual(messages.slice(10).map((m) => m.id));
  const empty = await getStaffConversation(staff, "conv-a", { window: win({ limit: 50, after: cursor }) });
  expect(empty.data.messages).toEqual([]);
  expect(empty.data.latest_cursor).toBe(cursor);
  expect(empty.data.has_newer).toBe(false);
});

test("is_mine 只在员工端、按登录员工计算；顾客端无 is_mine / sender_user_id / 内部备注", async () => {
  const s = await getStaffConversation(staff, "conv-a", { window: win({ limit: 100 }) });
  for (const m of s.data.messages) {
    const src = messages.find((x) => x.id === m.id);
    expect(m.is_mine).toBe(src.sender_user_id === "me");
    expect(m).not.toHaveProperty("sender_user_id");
  }
  const c = await getCustomerConversation("customer-a", "conv-a");
  const json = JSON.stringify(c.data.messages);
  expect(json).not.toContain("is_mine");
  expect(json).not.toContain("sender_user_id");
  expect(c.data.messages.some((m) => m.internal)).toBe(false);
});

test("旧 API 兼容：不传参数仍返回 conversation/messages/has_more 并新增游标字段", async () => {
  const r = await getStaffConversation(staff, "conv-a");
  expect(Object.keys(r.data)).toEqual(expect.arrayContaining(["conversation", "messages", "has_more", "has_newer", "older_cursor", "latest_cursor", "can_reply", "can_note"]));
  expect(r.data.conversation).toHaveProperty("last_customer_message_at");
  expect(r.data.conversation).toHaveProperty("customer_avatar_url");
});

test("员工头像/名称缓存：连续轮询不重复调用 admin.getUserById", async () => {
  await getStaffConversation(staff, "conv-a", { window: win({ limit: 50 }) });
  const first = authCalls.length;
  await getStaffConversation(staff, "conv-a", { window: win({ limit: 50 }) });
  await getStaffConversation(staff, "conv-a", { window: win({ limit: 50 }) });
  expect(authCalls.length).toBe(first);
});

test("纯函数：shapeMessageWindow 输出正序且游标正确", () => {
  const w = win({ limit: 2 });
  const rows = [messages[5], messages[4], messages[3]]; // 倒序 limit+1
  const s = shapeMessageWindow(w, rows);
  expect(s.rows.map((r) => r.id)).toEqual([messages[4].id, messages[5].id]);
  expect(s.has_more).toBe(true);
  expect(s.older_cursor).toBe(encodeMessageCursor(messages[4]));
});

test("摘要：单次聚合 RPC，不再逐会话查询消息表；已读写入与摘要使用同一 read_at", async () => {
  const r = await getStaffConversation(staff, "conv-a", { window: win({ limit: 50 }) });
  const stats = rpcLog.filter(([f]) => f === "support_conversation_stats");
  const marks = rpcLog.filter(([f]) => f === "support_mark_read");
  expect(stats.length).toBe(1);
  expect(marks.length).toBe(1);
  expect(stats[0][1].p_user_id).toBe("me");
  expect(stats[0][1].p_read_at).toBe(marks[0][1].p_read_at);
  expect(r.data.conversation.unread_count).toBe(7);
  expect(r.data.conversation.last_customer_message_at).toBe(SAME_TS);
  // 消息表只被消息窗口查询 1 次（无 per-conversation count / last 查询）
  expect(queries.filter((q) => q.table === "support_messages").length).toBe(1);
  expect(queries.some((q) => q.table === "support_participants" && q.upsert)).toBe(false);
});

test("阶段耗时：auth → summary/messages 均被标记，且授权失败时不进入后续阶段", async () => {
  const marks = [];
  await getStaffConversation(staff, "conv-a", { window: win({ limit: 10 }), timing: { mark: (n) => marks.push(n) } });
  expect(marks[0]).toBe("auth");
  expect(marks).toEqual(expect.arrayContaining(["summary", "messages"]));
  const denied = [];
  await getStaffConversation(hq, "conv-a", { locationId: OTHER_LOC, timing: { mark: (n) => denied.push(n) } });
  expect(denied).toEqual(["auth"]);
  expect(rpcLog.filter(([f]) => f === "support_mark_read").length).toBe(1);
});
