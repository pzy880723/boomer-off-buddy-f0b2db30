import { test } from "node:test";
import assert from "node:assert/strict";
import {
  processNewcomerSlot,
  runNewcomerWorker,
  parseTakeResponse,
  parseQueryResponse,
  deriveVerifyCode,
  syncYouzanCouponMirrors,
  type NewcomerClaim,
  type NewcomerDeps,
  type MirrorSyncDeps,
} from "./newcomer-benefit.server.ts";

const claim = (o: Partial<NewcomerClaim> = {}): NewcomerClaim => ({
  slot_id: "s1", claim_token: "t1", mode: "dispatch", request_key: "nc:g:1", customer_id: "c1",
  youzan_coupon_group_id: "G1", threshold_fen: 4990, amount_fen: 500, validity_days: 90, attempts: 1, ...o });

function deps(o: Partial<NewcomerDeps> = {}) {
  const finished: unknown[] = []; let takes = 0;
  const d: NewcomerDeps = {
    workerEnabled: () => true, customerAllowed: () => true,
    claim: async () => [claim()],
    finish: async (...a) => { finished.push(a); return String(a[2]); },
    resolveMember: async () => ({ yzOpenId: "yz" }),
    take: async () => { takes++; return { kind: "ok", couponId: "Y1" }; },
    queryHeld: async () => ({ kind: "unsupported", reason: "coupon_holding_query_unconfirmed" }),
    ...o,
  };
  return { d, finished, takes: () => takes };
}

test("success only with Youzan coupon id", async () => {
  const { d, finished } = deps();
  assert.equal(await processNewcomerSlot(claim(), d), "succeeded");
  assert.deepEqual((finished[0] as unknown[]).slice(2, 4), ["succeeded", "Y1"]);
});
test("missing template blocks without calling Youzan", async () => {
  const { d, takes } = deps();
  assert.equal(await processNewcomerSlot(claim({ youzan_coupon_group_id: null }), d), "blocked");
  assert.equal(takes(), 0);
});
test("mapping missing retries briefly (waits for member-sync), no take", async () => {
  const { d, takes, finished } = deps({ resolveMember: async () => ({ blocked: "trusted_member_mapping_missing" }) });
  assert.equal(await processNewcomerSlot(claim(), d), "retry");
  assert.equal(takes(), 0);
  assert.equal((finished[0] as unknown[])[4], "trusted_member_mapping_missing");
});
test("mapping unavailable retries; mapping conflict stays blocked (never merge)", async () => {
  const a = deps({ resolveMember: async () => ({ blocked: "trusted_member_mapping_unavailable" }) });
  assert.equal(await processNewcomerSlot(claim(), a.d), "retry");
  assert.equal(a.takes(), 0);
  const b = deps({ resolveMember: async () => ({ blocked: "trusted_member_mapping_conflict" }) });
  assert.equal(await processNewcomerSlot(claim(), b.d), "blocked");
  assert.equal(b.takes(), 0);
});
test("timeout / 5xx is unknown, never retried as a fresh send", async () => {
  const { d } = deps({ take: async () => { throw new Error("timeout"); } });
  assert.equal(await processNewcomerSlot(claim(), d), "unknown");
});
test("reconcile never calls take", async () => {
  const { d, takes } = deps();
  assert.equal(await processNewcomerSlot(claim({ mode: "reconcile" }), d), "unknown");
  assert.equal(takes(), 0);
});
test("reconcile found records success", async () => {
  const a = deps({ queryHeld: async () => ({ kind: "found", couponId: "Y9" }) });
  assert.equal(await processNewcomerSlot(claim({ mode: "reconcile" }), a.d), "succeeded");
});
test("reconcile not_found stays unknown, never goes back to dispatch", async () => {
  const b = deps({ queryHeld: async () => ({ kind: "not_found" }) });
  const { finished } = b;
  assert.equal(await processNewcomerSlot(claim({ mode: "reconcile" }), b.d), "unknown");
  assert.deepEqual((finished[0] as unknown[]).slice(2, 4), ["unknown", null]);
  assert.equal((finished[0] as unknown[])[4], "reconcile_not_found");
});
test("non-canary customer is blocked", async () => {
  const { d, takes } = deps({ customerAllowed: () => false });
  assert.equal(await processNewcomerSlot(claim(), d), "blocked"); assert.equal(takes(), 0);
});
test("worker disabled claims nothing", async () => {
  let claimed = false;
  const { d } = deps({ workerEnabled: () => false, claim: async () => { claimed = true; return []; } });
  assert.equal((await runNewcomerWorker(d)).enabled, false); assert.equal(claimed, false);
});

// ---- 官方 send/3.0.2 合同：真实券 ID 只在 data.voucher_identity.coupon_id ----
test("take response parsing: nested voucher_identity.coupon_id only", () => {
  assert.equal(parseTakeResponse(502, {}).kind, "unknown");
  assert.equal(parseTakeResponse(200, { code: 200, data: {} }).kind, "unknown");
  assert.equal(parseTakeResponse(200, { code: 141502, success: false }).kind, "rejected");
  // 顶层 id / verify_code 绝不能当作券 ID
  assert.equal(parseTakeResponse(200, { code: 200, data: { coupon_id: 12 } }).kind, "unknown");
  assert.equal(parseTakeResponse(200, { code: 200, data: { verify_code: "ZAN123" } }).kind, "unknown");
  assert.deepEqual(
    parseTakeResponse(200, { code: 200, data: { voucher_identity: { coupon_id: 70033678614 } } }),
    { kind: "ok", couponId: "70033678614" });
  assert.deepEqual(
    parseTakeResponse(200, { code: 200, data: { voucher_identity: { coupon_id: "abc" } } }),
    { kind: "ok", couponId: "abc" });
});

// ---- verify_code 派生：6-20 位字母数字，不以 ZAN/YZAN 开头，与 SQL 函数一致 ----
test("deriveVerifyCode is stable, 15 chars, alnum, no ZAN prefix", () => {
  const v1 = deriveVerifyCode("nc:c39fd499-9345-4906-b829-0f3f80ae4e9d:1");
  assert.equal(v1, deriveVerifyCode("nc:c39fd499-9345-4906-b829-0f3f80ae4e9d:1"));
  assert.match(v1, /^[a-z0-9]{15}$/);
  assert.ok(!/^y?zan/i.test(v1));
  assert.notEqual(v1, deriveVerifyCode("nc:c39fd499-9345-4906-b829-0f3f80ae4e9d:2"));
  // 与 SQL commerce_newcomer_verify_code 同一向量（sha256 前 12 位 hex）
  assert.equal(v1, "ncv" + "4a2677cae13b");
});

// ---- voucher.query/3.0.0 回查：data 数组 + 精准匹配 + 翻页到 total ----
test("query response: exact match on yz_open_id + activity_id + verify_code", () => {
  const page = {
    code: 200,
    data: {
      total: 2,
      vouchers: [
        { user_identity: { yz_open_id: "yz" }, activity_id: 35074322, verify_code: "ncvaaa", voucher_identity: { coupon_id: "111" } },
        { user_identity: { yz_open_id: "yz" }, activity_id: 35074322, verify_code: "ncvbbb", voucher_identity: { coupon_id: "222" } },
      ],
    },
  };
  assert.deepEqual(parseQueryResponse(200, page, { yzOpenId: "yz", activityId: "35074322", verifyCode: "ncvbbb" }),
    { kind: "found", couponId: "222", youzanStatus: "unknown" });
  // 同一活动另一槽的券不能补未知槽
  assert.deepEqual(parseQueryResponse(200, page, { yzOpenId: "yz", activityId: "35074322", verifyCode: "ncvccc" }),
    { kind: "not_found" });
  // 别的会员的券不算
  assert.deepEqual(parseQueryResponse(200, page, { yzOpenId: "other", activityId: "35074322", verifyCode: "ncvbbb" }),
    { kind: "not_found" });
  assert.equal(parseQueryResponse(500, {}, { yzOpenId: "yz", activityId: "1", verifyCode: "x" }).kind, "unavailable");
  assert.equal(parseQueryResponse(200, { code: 12345 }, { yzOpenId: "yz", activityId: "1", verifyCode: "x" }).kind, "unavailable");
});

// ---- 有赞持券只读同步：镜像状态跟进，绝不写积分 ----
function mirrorDeps(o: Partial<MirrorSyncDeps>, mirrors: Array<Record<string, unknown>>) {
  const updates: unknown[] = [];
  const d: MirrorSyncDeps = {
    syncEnabled: () => true,
    listActiveMirrors: async () => mirrors as never,
    queryHeldByVerifyCode: async () => ({ kind: "found", couponId: "x", youzanStatus: "used" }),
    updateMirrorStatus: async (...a) => { updates.push(a); },
    ...o,
  };
  return { d, updates };
}

test("mirror sync maps youzan status to local mirror status", async () => {
  const mirrors = [
    { id: "m1", code: "ncvaaa", external_id: "111", metadata: { activity_id: "1", yz_open_id: "yz" } },
    { id: "m2", code: "ncvbbb", external_id: "222", metadata: { activity_id: "1", yz_open_id: "yz" } },
  ];
  const { d, updates } = mirrorDeps({}, mirrors);
  const r = await syncYouzanCouponMirrors(d, 10);
  assert.equal(r.synced, 2);
  assert.deepEqual(updates, [["m1", "used"], ["m2", "used"]]);
});
test("mirror sync disabled does nothing", async () => {
  const { d, updates } = mirrorDeps({ syncEnabled: () => false }, [{ id: "m1" }]);
  assert.equal((await syncYouzanCouponMirrors(d, 10)).synced, 0);
  assert.equal(updates.length, 0);
});
test("mirror sync skips unknown query results without touching mirror", async () => {
  const { d, updates } = mirrorDeps(
    { queryHeldByVerifyCode: async () => ({ kind: "unavailable" }) },
    [{ id: "m1", code: "ncvaaa", external_id: "111", metadata: { activity_id: "1", yz_open_id: "yz" } }]);
  assert.equal((await syncYouzanCouponMirrors(d, 10)).synced, 0);
  assert.equal(updates.length, 0);
});
test("mirror sync never maps to active and never touches erp coupons", async () => {
  const { d, updates } = mirrorDeps(
    { queryHeldByVerifyCode: async () => ({ kind: "found", couponId: "x", youzanStatus: "active" }) },
    [{ id: "m1", code: "ncvaaa", external_id: "111", metadata: { activity_id: "1", yz_open_id: "yz" } }]);
  await syncYouzanCouponMirrors(d, 10);
  assert.equal(updates.length, 0); // 已 active 的镜像不重复写
});
