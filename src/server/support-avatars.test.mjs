import { beforeEach, expect, mock, test } from "bun:test";
import { safePublicAvatarUrl, senderPresentation } from "@/lib/support-avatar-policy";
const queries = [];
let rpcCalls = 0;
let authCalls = [];
let locationId = "store-a";
let owner = "customer-a";
let immediateType = "staff";
const messages = [
  { id: "m1", sender_type: "customer", sender_customer_id: "customer-a", sender_user_id: null, sender_name: "顾客", body: "hello", internal: false },
  { id: "m2", sender_type: "staff", sender_customer_id: null, sender_user_id: "old-store", sender_name: "private@example.com", body: "reply", internal: false },
  { id: "m3", sender_type: "staff", sender_customer_id: null, sender_user_id: "hq-one", sender_name: "hq@example.com", body: "hq", internal: false },
  { id: "m4", sender_type: "staff", sender_customer_id: null, sender_user_id: "hq-two", sender_name: "other@example.com", body: "note", internal: true }
].map((m, i) => ({ ...m, delivery_status: "sent", created_at: `2026-10-05T12:00:0${i}Z` }));
mock.module("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table) {
      const q = { table, columns: "", filters: [] };
      queries.push(q);
      const chain = {
        select(columns) {
          q.columns = columns;
          return chain;
        },
        eq(key, value) {
          q.filters.push([key, value]);
          return chain;
        },
        in(key, value) {
          q.filters.push([key, value]);
          return chain;
        },
        order() {
          return chain;
        },
        limit() {
          return chain;
        },
        upsert() {
          return Promise.resolve({ error: null });
        },
        maybeSingle() {
          return Promise.resolve(result());
        },
        then(resolve) {
          return Promise.resolve(result()).then(resolve);
        }
      };
      function result() {
        if (table === "support_conversations")
          return { data: { id: "conv-a", customer_id: owner, location_id: locationId, primary_agent_id: "hq-one", status: "open", channel: "native", assignment_version: 1 }, error: null };
        if (table === "support_messages")
          return { data: messages.filter((m) => !q.filters.some(([k, v]) => k === "internal" && m.internal !== v)).reverse(), error: null, count: 1 };
        if (table === "support_participants")
          return { data: [
            { conversation_id: "conv-a", user_id: "old-store", participant_role: "store_staff", display_name: "员工" },
            { conversation_id: "conv-a", user_id: "hq-one", participant_role: "hq_agent", display_name: "总部" },
            { conversation_id: "conv-a", user_id: "hq-two", participant_role: "hq_agent", display_name: "总部2" }
          ], error: null };
        if (table === "commerce_customers")
          return { data: q.columns === "avatar_url" ? { avatar_url: "https://images.example.com/customer.jpg" } : [{ id: owner, nickname: "顾客", avatar_url: "https://images.example.com/customer.jpg" }], error: null };
        if (table === "inv_locations")
          return { data: q.columns === "name,shop_id" ? { name: "A店", shop_id: "shop-a" } : [{ id: locationId, name: "A店" }], error: null };
        if (table === "youzan_shops")
          return { data: { image_url: "https://images.example.com/store-a.jpg" }, error: null };
        return { data: [], error: null };
      }
      return chain;
    },
    auth: { admin: { async getUserById(id) {
      authCalls.push(id);
      return { data: { user: { app_metadata: id === "hq-one" ? { avatar_url: "https://images.example.com/hq-one.jpg" } : {}, user_metadata: { avatar_url: "https://images.example.com/unverified.jpg", name: "总部" } } }, error: null };
    } } },
    async rpc(fn, args) {
      if (fn === "support_conversation_stats") return { data: args.p_conversation_ids.map((id) => ({ conversation_id: id, unread_count: 0, last_customer_message_at: null })), error: null };
      if (fn === "support_mark_read") return { data: args.p_read_at, error: null };
      rpcCalls++;
      return { data: { ok: true, message: messages[immediateType === "customer" ? 0 : 1], replayed: false }, error: null };
    }
  }
}));
mock.module("@/server/handheld-auth.server", () => ({ loadUserRoles: async () => [] }));
const { getCustomerConversation, getStaffConversation, postCustomerMessage, postStaffMessage } = await import("@/server/support.server");
const staff = { user_id: "old-store", display_name: "员工", is_hq_agent: false, location_ids: ["store-a"], participant_role: "store_staff" };
beforeEach(() => {
  queries.length = 0;
  rpcCalls = 0;
  authCalls = [];
  locationId = "store-a";
  owner = "customer-a";
  immediateType = "staff";
});
test("safe public HTTPS URL accepted; private/signed/credential/query/non-HTTPS URLs rejected", () => {
  expect(safePublicAvatarUrl("https://images.example.com/a.jpg")).toBe("https://images.example.com/a.jpg");
  for (const url of [null, "bucket/key", "http://images.example.com/a.jpg", "https://user:pass@images.example.com/a.jpg", "https://images.example.com/a.jpg?token=x", "https://images.example.com/storage/v1/object/sign/a", "https://images.example.com/private/a", "https://127.0.0.1/a", "https://[::1]/a", "https://localhost/a", "https://host.internal/a", "data:image/png;base64,a"])
    expect(safePublicAvatarUrl(url)).toBeNull();
});
test("customer avatar cannot come from another customer", () => {
  expect(senderPresentation({ sender_type: "customer", sender_customer_id: "other", conversation_customer_id: "customer-a", customer_avatar_url: "https://images.example.com/other.jpg" }).sender_avatar_url).toBeNull();
});
test("unknown historical staff is not assigned the primary agent's role", () => {
  expect(senderPresentation({ sender_type: "staff", sender_customer_id: null, conversation_customer_id: "customer-a", hq_avatar_url: "https://images.example.com/hq.jpg" })).toEqual({ sender_role: "system", sender_avatar_url: null, sender_location_name: null });
});
test("customer GET rejects wrong owner before avatar or message lookup", async () => {
  const r = await getCustomerConversation("other", "conv-a");
  expect(r.ok).toBe(false);
  expect(queries.map((q) => q.table)).toEqual(["support_conversations"]);
  expect(authCalls).toEqual([]);
});
test("staff GET rejects unauthorized store before avatar queries", async () => {
  locationId = "store-b";
  expect((await getStaffConversation(staff, "conv-a")).ok).toBe(false);
  expect(queries.map((q) => q.table)).toEqual(["support_conversations"]);
});
test("customer GET filters internal and projects no staff ID/email; roles use actual senders", async () => {
  const r = await getCustomerConversation("customer-a", "conv-a");
  if (!r.ok)
    throw new Error("expected authorized response");
  expect(r.data.messages.map((m) => m.sender_role)).toEqual(["customer", "store_staff", "hq_agent"]);
  expect(r.data.messages[1]?.sender_avatar_url).toBe("https://images.example.com/store-a.jpg");
  expect(r.data.messages[1]?.sender_location_name).toBe("A店");
  expect(r.data.messages[2]?.sender_avatar_url).toBe("https://images.example.com/hq-one.jpg");
  const json = JSON.stringify(r.data.messages);
  expect(json).not.toContain("sender_user_id");
  expect(json).not.toContain("@example.com");
  expect(json).not.toContain('"note"');
  expect(queries.find((q) => q.table === "youzan_shops")?.filters).toContainEqual(["id", "shop-a"]);
});
test("HQ self-editable metadata is not trusted, missing verified avatar falls back null", async () => {
  const r = await getStaffConversation(staff, "conv-a");
  if (!r.ok)
    throw new Error("expected authorized response");
  expect(r.data.messages[3]?.sender_role).toBe("hq_agent");
  expect(r.data.messages[3]?.sender_avatar_url).toBeNull();
  expect(r.data.conversation.customer_avatar_url).toBe("https://images.example.com/customer.jpg");
});
test("staff POST immediate message matches GET presentation contract", async () => {
  const r = await postStaffMessage({ access: staff, conversationId: "conv-a", body: "reply", internal: false, clientOpId: "op", assignmentVersion: 1 });
  if (!r.ok)
    throw new Error("expected success");
  const get = await getStaffConversation(staff, "conv-a");
  if (!get.ok)
    throw new Error("expected get");
  expect(r.data.message).toEqual(get.data.messages[1]);
});
test("customer POST immediate message matches GET and prevents cross-customer lookup", async () => {
  immediateType = "customer";
  const r = await postCustomerMessage({ customerId: "customer-a", customerName: "顾客", conversationId: "conv-a", body: "hello", clientOpId: "op" });
  if (!r.ok)
    throw new Error("expected success");
  const get = await getCustomerConversation("customer-a", "conv-a");
  if (!get.ok)
    throw new Error("expected get");
  expect(r.data.message).toEqual(get.data.messages[0]);
  queries.length = 0;
  rpcCalls = 0;
  expect((await postCustomerMessage({ customerId: "other", customerName: "顾客", conversationId: "conv-a", body: "hello", clientOpId: "op" })).ok).toBe(false);
  expect(rpcCalls).toBe(0);
  expect(queries.map((q) => q.table)).toEqual(["support_conversations"]);
});
test("staff POST cannot use a different store for sender avatar", async () => {
  locationId = "store-b";
  expect((await postStaffMessage({ access: staff, conversationId: "conv-a", body: "reply", internal: true, clientOpId: "op" })).ok).toBe(false);
  expect(rpcCalls).toBe(0);
  expect(queries.map((q) => q.table)).toEqual(["support_conversations"]);
});
