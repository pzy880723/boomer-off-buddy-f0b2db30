// 路由封装测试：真实路由 handler + 真实 server helper，仅替换数据库客户端与设备/员工鉴权。
import { beforeEach, expect, mock, test } from "bun:test";

const LOC = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const SKU_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SKU_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SKU_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER = "55555555-5555-4555-8555-555555555555";
const OP = "66666666-6666-4666-8666-666666666666";
const TOKEN = "77777777-7777-4777-8777-777777777777";

let tables; let rpcCalls; let rpcImpl; let session; let device;
function reset() {
  tables = {
    user_roles: [{ user_id: USER, role: "store_manager" }],
    user_location_perms: [{ user_id: USER, location_id: LOC }],
    inv_locations: [{ id: LOC, kind: "shop", shop_id: "shop-1", is_active: true }, { id: OTHER, kind: "shop", shop_id: "shop-2", is_active: true }],
    inv_stocks: [{ sku_id: SKU_A, location_id: LOC, qty: 1 }, { sku_id: SKU_B, location_id: LOC, qty: 1 }],
    inv_skus: [{ id: SKU_A, sales_state: "active" }, { id: SKU_B, sales_state: "active" }, { id: SKU_C, sales_state: "active" }],
    commerce_listings: [{ sku_id: SKU_A, location_id: LOC, status: "published", readiness_hold: false }],
    sku_sales_channel_intents: [],
    sku_channel_listings: [{ id: "yz-a", sku_id: SKU_A, shop_id: "shop-1", channel: "youzan_branch_offline", external_item_id: "1", listing_status: "published", last_verified_at: null, updated_at: "2026-10-01" }],
    youzan_shops: [{ id: "shop-1", expires_at: null, access_token: "x" }],
    channel_sync_outbox: [],
    sku_sales_channel_previews: [],
  };
  rpcCalls = []; rpcImpl = {}; session = { user_id: USER }; device = { ok: true };
}
reset();

function query(table) {
  let rows = [...(tables[table] ?? [])];
  let inserted = null;
  const chain = {
    select() { return chain; },
    eq(k, v) { if (!k.includes("->>")) rows = rows.filter((r) => r[k] === v); return chain; },
    in(k, vs) { rows = rows.filter((r) => vs.includes(r[k])); return chain; },
    order() { return chain; }, limit() { return chain; },
    insert(row) { inserted = { token: TOKEN, ...row }; tables[table].push(inserted); return chain; },
    maybeSingle() { return Promise.resolve({ data: inserted ?? rows[0] ?? null, error: null }); },
    single() { return Promise.resolve({ data: inserted ?? rows[0] ?? null, error: null }); },
    then(res, rej) { return Promise.resolve({ data: rows, error: null }).then(res, rej); },
  };
  return chain;
}
mock.module("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: query,
    rpc(fn, args) { rpcCalls.push({ fn, args }); return Promise.resolve(rpcImpl[fn] ? rpcImpl[fn](args) : { data: null, error: { message: "unmocked" } }); },
  },
}));
const json = (b, i = {}) => new Response(JSON.stringify(b), { ...i, headers: { "Content-Type": "application/json" } });
mock.module("@/server/handheld-auth.server", () => ({
  HANDHELD_CORS: {},
  ok: (data) => json({ ok: true, data }),
  err: (message, status = 400, extra) => json({ ok: false, error: message, ...(extra || {}) }, { status }),
  authenticateDevice: async () => device,
  resolveSessionUser: async () => session,
}));
mock.module("@/server/consumer-auth.server", () => ({ consumerAuthEnvironment: () => null, verifyConsumerJwt: async () => ({}) }));

const single = (await import("@/routes/api/public/handheld/items.$id.sales-channels")).Route.options.server.handlers;
const preview = (await import("@/routes/api/public/handheld/sales-channels.batch-preview")).Route.options.server.handlers;
const apply = (await import("@/routes/api/public/handheld/sales-channels.batch-apply")).Route.options.server.handlers;

const req = (url, body) => new Request(`http://x${url}`, body ? { method: "POST", body: JSON.stringify(body) } : {});
const call = async (h, r, params) => { const res = await h({ request: r, params }); return { status: res.status, body: await res.json() }; };

beforeEach(reset);

test("auth: device, session, store scope and role are enforced", async () => {
  device = { ok: false };
  expect((await call(single.GET, req(`/i?location_id=${LOC}`), { id: SKU_A })).status).toBe(401);
  device = { ok: true }; session = null;
  expect((await call(single.GET, req(`/i?location_id=${LOC}`), { id: SKU_A })).status).toBe(401);
  session = { user_id: USER };
  const other = await call(single.GET, req(`/i?location_id=${OTHER}`), { id: SKU_A });
  expect(other.status).toBe(403);
  expect(other.body.error).toMatch(/[\u4e00-\u9fa5]/);
  tables.user_roles = [{ user_id: USER, role: "store_staff" }];
  const get = await call(single.GET, req(`/i?location_id=${LOC}`), { id: SKU_A });
  expect(get.status).toBe(200);
  expect(get.body.data.can_manage).toBe(false);
  const post = await call(single.POST, req("/i", { location_id: LOC, op_id: OP, changes: [{ channel: "app", enabled: false, expected_version: 0 }] }), { id: SKU_A });
  expect(post.status).toBe(403);
  expect(rpcCalls.length).toBe(0);
});

test("GET contract: three channels, selection separate from platform state", async () => {
  const { body } = await call(single.GET, req(`/i?location_id=${LOC}`), { id: SKU_A });
  expect(body.data.channels.map((c) => c.channel)).toEqual(["miniapp", "app", "youzan"]);
  expect(body.data.channels.every((c) => c.selection_source === "default")).toBe(true);
  expect(body.data.stock_quantity).toBe(1);
});

test("single POST: partial results are reported, not called complete; unknown reason in Chinese", async () => {
  rpcImpl.sales_channel_apply = () => ({ data: { replayed: false, results: [
    { sku_id: SKU_A, channel: "app", success: true, status: "applied" },
    { sku_id: SKU_A, channel: "youzan", success: false, reason: "weird_new_code" },
  ] }, error: null });
  const { status, body } = await call(single.POST, req("/i", { location_id: LOC, op_id: OP, changes: [
    { channel: "app", enabled: false, expected_version: 0 }, { channel: "youzan", enabled: false, expected_version: 0 }] }), { id: SKU_A });
  expect(status).toBe(200);
  expect(body.data.all_succeeded).toBe(false);
  expect(body.data.succeeded).toBe(1);
  expect(body.data.failed).toBe(1);
  expect(body.data.results[1].reason).toBe("操作未完成，请刷新后重试");
  expect(rpcCalls[0].args.p_kind).toBe("single");
  expect(rpcCalls[0].args.p_actor).toBe(USER);
});

test("single POST: duplicate channel rejected before DB; DB op conflict mapped to Chinese 409", async () => {
  const dup = await call(single.POST, req("/i", { location_id: LOC, op_id: OP, changes: [
    { channel: "app", enabled: false, expected_version: 0 }, { channel: "app", enabled: true, expected_version: 0 }] }), { id: SKU_A });
  expect(dup.status).toBe(400);
  rpcImpl.sales_channel_apply = () => ({ data: null, error: { message: "op_id_conflict" } });
  const c = await call(single.POST, req("/i", { location_id: LOC, op_id: OP, changes: [{ channel: "app", enabled: false, expected_version: 0 }] }), { id: SKU_A });
  expect(c.status).toBe(409);
  expect(c.body.error).toBe("操作编号已用于其他请求");
});

test("batch preview: SKU skipped as a whole when any requested channel is blocked; snapshot keeps all ids", async () => {
  // A: app 可关、youzan 可关；B: 无有赞映射 → 整件跳过；C: 不在本店 → 跳过
  const { status, body } = await call(preview.POST, req("/p", { location_id: LOC, sku_ids: [SKU_A, SKU_B, SKU_C], add: [], remove: ["app", "youzan"] }));
  expect(status).toBe(200);
  expect(body.data).toMatchObject({ total: 3, eligible: 1, preview_token: TOKEN });
  expect(body.data.skipped.map((s) => [s.sku_id, s.reason_code])).toEqual([[SKU_B, "youzan_not_mapped"], [SKU_C, "not_in_store"]]);
  const snap = tables.sku_sales_channel_previews[0];
  expect(snap.sku_ids).toEqual([SKU_A, SKU_B, SKU_C]);
  expect(snap.items.map((i) => i.sku_id)).toEqual([SKU_A]);
  expect(Object.keys(snap.items[0].changes).sort()).toEqual(["app", "youzan"]);
  const empty = await call(preview.POST, req("/p", { location_id: LOC, sku_ids: [SKU_A], add: [], remove: [] }));
  expect(empty.status).toBe(400);
});

test("batch apply: returns every originally selected SKU incl. skipped; replay identical", async () => {
  const dbResult = { results: [{ sku_id: SKU_A, channel: "app", success: true, status: "applied" }],
    sku_ids: [SKU_A, SKU_B, SKU_C], skipped: [{ sku_id: SKU_B, reason: "youzan_not_mapped" }, { sku_id: SKU_C, reason: "not_in_store" }] };
  let n = 0;
  rpcImpl.sales_channel_apply_preview = () => ({ data: { ...dbResult, replayed: n++ > 0 }, error: null });
  const body = { location_id: LOC, op_id: OP, preview_token: TOKEN };
  const first = await call(apply.POST, req("/a", body));
  const again = await call(apply.POST, req("/a", body));
  expect(first.body.data).toMatchObject({ total: 3, succeeded: 1, failed: 2 });
  expect(first.body.data.results.map((r) => [r.sku_id, r.success])).toEqual([[SKU_A, true], [SKU_B, false], [SKU_C, false]]);
  expect(first.body.data.results[1].reason).toMatch(/有赞/);
  expect(again.body.data.replayed).toBe(true);
  expect(again.body.data.results).toEqual(first.body.data.results);
  expect(first.body.data.succeeded + first.body.data.failed).toBe(first.body.data.total);
});

test("batch apply: expired/foreign preview errors are Chinese", async () => {
  rpcImpl.sales_channel_apply_preview = () => ({ data: null, error: { message: "preview_expired" } });
  const r = await call(apply.POST, req("/a", { location_id: LOC, op_id: OP, preview_token: TOKEN }));
  expect(r.status).toBe(410);
  expect(r.body.error).toBe("预览已过期，请重新预览");
});
