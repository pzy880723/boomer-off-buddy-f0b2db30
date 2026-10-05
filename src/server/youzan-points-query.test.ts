import assert from "node:assert/strict";
import { test } from "node:test";
import { createYouzanPointsQuery } from "./youzan-points-query.server";

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
  assert.deepEqual(r, { kind: "ok", kdtId: 100, yzOpenId: "OPEN1", assetKey: "", observed: { point: 120, points_account_version: 7 }, observedAt: 1234 });
  assert.match(calls[0].url, /^https:\/\/open\.youzanyun\.com\/api\/youzan\.crm\.customer\.points\.get\/1\.0\.0\?/);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { yz_open_id: "OPEN1", is_query_points_account_version: true });
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
