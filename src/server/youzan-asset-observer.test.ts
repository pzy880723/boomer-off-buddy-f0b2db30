import assert from "node:assert/strict";
import { test } from "node:test";
import {
  processObservationInbox,
  type ObservationDeps,
  type ObservationStore,
  type ObservationRecordArgs,
  type ObsRow,
} from "./youzan-asset-observer.server";

type Inbox = ObsRow & { status: string; reason: string | null; claim_token: string | null; lease_until: number | null };

function stores(rows: Inbox[]) {
  const snaps = new Map<string, { row_version: number; observed_at: number; observed: unknown }>();
  let tok = 0;
  const k = (a: { kdt_id: number; yz_open_id: string; asset_kind: string; asset_key: string }) =>
    `${a.kdt_id}|${a.yz_open_id}|${a.asset_kind}|${a.asset_key}`;
  const s: ObservationStore & { snaps: typeof snaps; rows: Inbox[] } = {
    rows, snaps,
    async claim(limit, now) {
      const due = rows.filter((r) => r.status === "pending" || r.status === "retry").slice(0, limit);
      for (const r of due) { r.status = "processing"; r.claim_token = `t${++tok}`; r.lease_until = now + 300_000; r.attempts++; }
      return due.map((r) => ({ ...r }));
    },
    async finish(id, token, status, reason) {
      const r = rows.find((x) => x.id === id)!;
      if (r.status !== "processing" || r.claim_token !== token) return false;
      r.status = status; r.reason = reason; r.claim_token = null; r.lease_until = null;
      return true;
    },
    async readVersion(key) { return snaps.get(k(key))?.row_version ?? 0; },
    async record(a: ObservationRecordArgs) {
      const r = rows.find((x) => x.id === a.inbox_id)!;
      if (r.status !== "processing" || r.claim_token !== a.claim_token) return "stale_lease";
      const cur = snaps.get(k(a));
      if ((cur?.row_version ?? 0) !== a.expected_row_version) return "stale_version";
      if (cur && a.observed_at <= cur.observed_at) {
        r.status = "blocked"; r.reason = "superseded_by_newer_observation"; r.claim_token = null;
        return "older_observation";
      }
      snaps.set(k(a), { row_version: (cur?.row_version ?? 0) + 1, observed_at: a.observed_at, observed: a.observed });
      r.status = "blocked"; r.reason = "observed_asset_adapter_not_connected"; r.claim_token = null;
      return "recorded";
    },
  };
  return s;
}

const pointsRow = (o: Partial<Inbox> = {}): Inbox => ({
  id: "r1", kdt_id: 100, msg_type: "POINTS", biz_id: "yuser_1", attempts: 0,
  payload: { yz_open_id: "OPEN1", total: 999 }, envelope: {},
  status: "pending", reason: null, claim_token: null, lease_until: null, ...o,
});
const couponRow = (o: Partial<Inbox> = {}): Inbox => ({
  id: "c1", kdt_id: 100, msg_type: "COUPON_CUSTOMER_PROMOTION", biz_id: "V9", attempts: 0,
  payload: { id: "V9", status: "CARD_TAKE" }, envelope: { yz_open_id: "OPEN1", voucher_id: "V9" },
  status: "pending", reason: null, claim_token: null, lease_until: null, ...o,
});

function deps(o: Partial<ObservationDeps> = {}): ObservationDeps {
  let t = 1_000;
  return {
    isActiveShop: async () => true,
    resolveIdentity: async ({ yz_open_id }) => ({ kind: "found", customerId: "cust-1", yzOpenId: yz_open_id }),
    queryAsset: async (q) => ({
      kind: "ok", kdtId: q.kdtId, yzOpenId: q.yzOpenId, assetKey: q.assetKey,
      observed: q.assetKind === "points" ? { total: 50, mobile: "13800000000" } : { status: "USED" },
      observedAt: ++t,
    }),
    now: () => t,
    ...o,
  };
}

test("没有可信映射依赖：blocked identity_resolver_not_connected，不记观察", async () => {
  const st = stores([pointsRow()]);
  await processObservationInbox(st, deps({ resolveIdentity: undefined }));
  assert.equal(st.rows[0].reason, "identity_resolver_not_connected");
  assert.equal(st.snaps.size, 0);
});

test("没有固定出口查询依赖：blocked asset_query_not_connected", async () => {
  const st = stores([pointsRow()]);
  await processObservationInbox(st, deps({ queryAsset: undefined }));
  assert.equal(st.rows[0].reason, "asset_query_not_connected");
  assert.equal(st.snaps.size, 0);
});

test("未知会员 blocked unknown_member；不凭手机号建会员（依赖只收 kdt_id+yz_open_id）", async () => {
  const st = stores([pointsRow({ payload: { yz_open_id: "X", mobile: "13800000000" } })]);
  let seen: unknown;
  await processObservationInbox(st, deps({ resolveIdentity: async (q) => { seen = q; return { kind: "unknown" }; } }));
  assert.equal(st.rows[0].reason, "unknown_member");
  assert.deepEqual(Object.keys(seen as object).sort(), ["kdt_id", "yz_open_id"]);
});

test("缺 yz_open_id：blocked missing_member_identity", async () => {
  const st = stores([couponRow({ envelope: {} })]);
  await processObservationInbox(st, deps());
  assert.equal(st.rows[0].reason, "missing_member_identity");
});

test("非授权店铺：blocked shop_not_authorized，不调用映射/查询", async () => {
  const st = stores([pointsRow()]);
  let called = false;
  await processObservationInbox(st, deps({ isActiveShop: async () => false, resolveIdentity: async () => { called = true; return { kind: "unknown" }; } }));
  assert.equal(st.rows[0].reason, "shop_not_authorized");
  assert.equal(called, false);
});

test("记录的是有赞查询结果，不是通知里的 total；手机号字段剥离；收件仍无成功态", async () => {
  const st = stores([pointsRow()]);
  const out = await processObservationInbox(st, deps());
  assert.equal(out.observed, 1);
  const snap = [...st.snaps.values()][0];
  assert.deepEqual(snap.observed, { total: 50 });
  assert.equal(st.rows[0].status, "blocked");
  assert.equal(st.rows[0].reason, "observed_asset_adapter_not_connected");
});

test("查询结果身份/店铺/券号与映射不一致：blocked query_identity_mismatch", async () => {
  for (const bad of [{ yzOpenId: "OTHER" }, { kdtId: 7 }, { assetKey: "V0" }]) {
    const st = stores([couponRow()]);
    await processObservationInbox(st, deps({
      queryAsset: async (q) => ({ kind: "ok", kdtId: q.kdtId, yzOpenId: q.yzOpenId, assetKey: q.assetKey, observed: {}, observedAt: 5, ...bad }),
    }));
    assert.equal(st.rows[0].reason, "query_identity_mismatch", JSON.stringify(bad));
    assert.equal(st.snaps.size, 0);
  }
});

test("映射返回的 yz_open_id 为准：通知外层 id 只是线索", async () => {
  const st = stores([couponRow({ envelope: { yz_open_id: "HINT", voucher_id: "V9" } })]);
  let asked = "";
  await processObservationInbox(st, deps({
    resolveIdentity: async () => ({ kind: "found", customerId: "c", yzOpenId: "TRUSTED" }),
    queryAsset: async (q) => { asked = q.yzOpenId; return { kind: "ok", kdtId: q.kdtId, yzOpenId: q.yzOpenId, assetKey: q.assetKey, observed: {}, observedAt: 9 }; },
  }));
  assert.equal(asked, "TRUSTED");
});

test("旧查询结果不能覆盖新结果（乱序/慢 worker）", async () => {
  const st = stores([pointsRow({ id: "a" }), pointsRow({ id: "b" })]);
  const times = [200, 100]; // 第二条查询时间更早
  await processObservationInbox(st, deps({
    queryAsset: async (q) => ({ kind: "ok", kdtId: q.kdtId, yzOpenId: q.yzOpenId, assetKey: q.assetKey, observed: { total: times[0] }, observedAt: times.shift()! }),
  }));
  assert.deepEqual([...st.snaps.values()][0].observed, { total: 200 });
  assert.equal(st.rows[1].reason, "superseded_by_newer_observation");
});

test("乐观版本：读版本后被别人写入 → stale_version 重排 retry", async () => {
  const st = stores([pointsRow()]);
  await processObservationInbox(st, deps({
    queryAsset: async (q) => {
      st.snaps.set(`100|OPEN1|points|`, { row_version: 1, observed_at: 1, observed: {} });
      return { kind: "ok", kdtId: q.kdtId, yzOpenId: q.yzOpenId, assetKey: q.assetKey, observed: { total: 1 }, observedAt: 50 };
    },
  }));
  assert.equal(st.rows[0].status, "retry");
  assert.equal(st.rows[0].reason, "stale_version");
});

test("lease 丢失（fencing）：stale，不写快照", async () => {
  const st = stores([pointsRow()]);
  const out = await processObservationInbox(st, deps({
    queryAsset: async (q) => { st.rows[0].claim_token = "someone-else"; return { kind: "ok", kdtId: q.kdtId, yzOpenId: q.yzOpenId, assetKey: q.assetKey, observed: {}, observedAt: 5 }; },
  }));
  assert.equal(out.stale, 1);
  assert.equal(st.snaps.size, 0);
});

test("查询暂不可用/抛错：retry，原因固定安全代码", async () => {
  const st = stores([pointsRow()]);
  await processObservationInbox(st, deps({ queryAsset: async () => { throw new Error("token=SECRET"); } }));
  assert.equal(st.rows[0].status, "retry");
  assert.equal(st.rows[0].reason, "transient_error");
});
