import assert from "node:assert/strict";
import { test } from "node:test";
import { createYouzanPointsQuery, selectPointsHeadquarters } from "./youzan-points-query.server";

const q = { kdtId: 100, yzOpenId: "OPEN1", assetKind: "points" as const, assetKey: "" };
const mk = (o: Partial<Parameters<typeof createYouzanPointsQuery>[0]> = {}, body: unknown = { success: true, code: 200, data: { point: 120, points_account_version: 7 } }) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = createYouzanPointsQuery({
    proxyConfigured: () => true,
    getAccessToken: async () => "TOK",
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status: 200 }); },
    now: () => 1234,
    ...o,
  });
  return { f, calls };
};

test("只读 points.get 1.0.0，带 is_query_points_account_version=true，返回 point/version", async () => {
  const { f, calls } = mk();
  const r = await f(q);
  assert.deepEqual(r, { kind: "ok", kdtId: 100, yzOpenId: "OPEN1", assetKey: "", observed: { point: 120, points_account_version: "7" }, observedAt: 1234 });
  assert.match(calls[0].url, /^https:\/\/open\.youzanyun\.com\/api\/youzan\.crm\.customer\.points\.get\/1\.0\.0\?/);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { user: { account_id: "OPEN1", account_type: 5 }, is_do_extpoint: false, is_query_points_account_version: true });
  assert.ok(calls[0].init.signal);
});

test("versions preserve int64 precision and invalid balances never become observations", async () => {
  const result = await mk({}, { code: 200, data: { point: 0, points_account_version: "9007199254740999" } }).f(q);
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") assert.equal(result.observed.points_account_version, "9007199254740999");
  for (const data of [{ point: -1, points_account_version: 2 }, { point: 3, points_account_version: -1 }]) {
    assert.equal((await mk({}, { code: 200, data }).f(q)).kind, "blocked");
  }
});
test("unquoted provider int64 versions retain every original digit", async () => {
  const f = mk({fetchImpl:async()=>new Response('{"success":true,"code":200,"data":{"point":1,"points_account_version":1234567890123456789}}')}).f;
  const r = await f(q);
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") assert.equal(r.observed.points_account_version, "1234567890123456789");
  for (const version of ["1.5", "1e18", "12345678901234567890"]) {
    const invalid = mk({fetchImpl:async()=>new Response(`{"code":200,"data":{"point":1,"points_account_version":${version}}}`)}).f;
    assert.equal((await invalid(q)).kind, "blocked");
  }
});

test("non-2xx and explicit rejection cannot pass with a success-looking body", async () => {
  assert.equal((await mk({}, { code: 200, success: false, data: { point: 10, points_account_version: 1 } }).f(q)).kind, "blocked");
  const { f } = mk({ fetchImpl: async () => Response.json({ code: 200, success: true, data: { point: 10, points_account_version: 1 } }, { status: 401 }) });
  assert.equal((await f(q)).kind, "blocked");
});

test("未配置固定出口：blocked，不发请求", async () => {
  const { f, calls } = mk({ proxyConfigured: () => false });
  assert.deepEqual(await f(q), { kind: "blocked", reason: "youzan_proxy_not_configured" });
  assert.equal(calls.length, 0);
});

test("优惠券：asset_query_not_supported", async () => {
  const { f } = mk();
  assert.deepEqual(await f({ ...q, assetKind: "coupon", assetKey: "V" }), { kind: "blocked", reason: "asset_query_not_supported" });
});

test("缺 points_account_version / 有赞拒绝 → blocked；5xx/网络 → unavailable", async () => {
  assert.equal((await mk({}, { success: true, data: { point: 1 } }).f(q)).kind, "blocked");
  assert.deepEqual(await mk({}, { success: false, code: 4001 }).f(q), { kind: "blocked", reason: "youzan_query_rejected" });
  assert.equal((await mk({ fetchImpl: async () => new Response("x", { status: 502 }) }).f(q)).kind, "unavailable");
  assert.equal((await mk({ fetchImpl: async () => { throw new Error("TOK leaked?"); } }).f(q)).kind, "unavailable");
});

test("无店铺 token：blocked shop_token_missing", async () => {
  assert.deepEqual(await mk({ getAccessToken: async () => null }).f(q), { kind: "blocked", reason: "shop_token_missing" });
});

test("branch points queries use only their authorized headquarters' unexpired token", () => {
  const shops = [{ kdt_id: 100, role: "hq", status: "active", access_token: "HEAD", token_expires_at: "2030-01-01T00:00:00Z" },
    { kdt_id: 101, parent_kdt_id: 100, role: "branch", status: "active", access_token: "BRANCH" }];
  assert.equal(selectPointsHeadquarters(shops, 101, 1000)?.access_token, "HEAD");
  assert.equal(selectPointsHeadquarters(shops, 100, 1000)?.access_token, "HEAD");
  assert.equal(selectPointsHeadquarters(shops, 102, 1000), null);
  assert.equal(selectPointsHeadquarters(shops.map(s => ({ ...s, status: "inactive" })), 101, 1000), null);
  assert.equal(selectPointsHeadquarters(shops, 101, Date.parse("2030-01-01T00:00:00Z")), null);
  assert.equal(selectPointsHeadquarters(shops.slice(1), 101, 1000), null);
});
