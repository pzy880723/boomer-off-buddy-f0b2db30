import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveVerifyCode,
  parseQueryResponse,
  parseTakeResponse,
  processNewcomerSlot,
  runNewcomerWorker,
  syncYouzanCouponMirrors,
  type MirrorSyncDeps,
  type NewcomerClaim,
  type NewcomerDeps,
  type TakeReceipt,
} from "./newcomer-benefit.server.ts";

const receipt = (o: Partial<TakeReceipt> = {}): TakeReceipt => ({
  couponId: "Y1", verifyCode: "YZVC001",
  validStart: "2026-10-17T16:00:00.000Z", validEnd: "2027-01-15T15:59:59.000Z", ...o });

const claim = (o: Partial<NewcomerClaim> = {}): NewcomerClaim => ({
  slot_id: "s1", claim_token: "t1", mode: "dispatch", request_key: "nc:g:1", customer_id: "c1",
  youzan_coupon_group_id: "35074448", threshold_fen: 4990, amount_fen: 500, validity_days: 90, attempts: 1, ...o });

function deps(o: Partial<NewcomerDeps> = {}) {
  const finished: unknown[] = []; const succeeded: unknown[] = []; let takes = 0;
  const d: NewcomerDeps = {
    workerEnabled: () => true, customerAllowed: () => true,
    claim: async () => [claim()],
    finish: async (...a) => { finished.push(a); return String(a[2]); },
    finishSuccess: async (...a) => { succeeded.push(a); return "succeeded"; },
    resolveMember: async () => ({ yzOpenId: "yz" }),
    take: async () => { takes++; return { kind: "ok", receipt: receipt() }; },
    queryHeld: async () => ({ kind: "unsupported", reason: "coupon_holding_query_unconfirmed" }),
    ...o,
  };
  return { d, finished, succeeded, takes: () => takes };
}

test("dispatch success goes through finishSuccess with real receipt and slot rules", async () => {
  const { d, succeeded, finished } = deps();
  assert.equal(await processNewcomerSlot(claim(), d), "succeeded");
  assert.equal(finished.length, 0);
  const [slotId, token, r] = succeeded[0] as [string, string, TakeReceipt & { amountFen: number; thresholdFen: number; activityId: string }];
  assert.equal(slotId, "s1"); assert.equal(token, "t1");
  assert.equal(r.couponId, "Y1"); assert.equal(r.verifyCode, "YZVC001");
  assert.equal(r.amountFen, 500); assert.equal(r.thresholdFen, 4990); assert.equal(r.activityId, "35074448");
});
test("receipt_mismatch from DB is surfaced, not hidden", async () => {
  const { d } = deps({ finishSuccess: async () => "receipt_mismatch" });
  assert.equal(await processNewcomerSlot(claim(), d), "receipt_mismatch");
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
test("reconcile found finishes with provider receipt; not_found stays unknown", async () => {
  const a = deps({ queryHeld: async () => ({ kind: "found", receipt: receipt({ couponId: "Y9" }), youzanStatus: "1" }) });
  assert.equal(await processNewcomerSlot(claim({ mode: "reconcile" }), a.d), "succeeded");
  assert.equal((a.succeeded[0] as unknown[])[2] && (a.succeeded[0] as [string, string, TakeReceipt])[2].couponId, "Y9");
  const b = deps({ queryHeld: async () => ({ kind: "not_found" }) });
  assert.equal(await processNewcomerSlot(claim({ mode: "reconcile" }), b.d), "not_found");
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

test("verify_code derived from request_key: stable, 15 chars, safe prefix", () => {
  const v = deriveVerifyCode("nc:c39fd499-9345-4906-b829-0f3f80ae4e9d:1");
  assert.equal(v, "ncv4a2677cae13b");
  assert.match(v, /^[a-z0-9]{15}$/);
  assert.ok(!/^zan|^yzan/i.test(v));
  assert.equal(deriveVerifyCode("nc:g:1"), deriveVerifyCode("nc:g:1"));
});

test("take response: only nested voucher_identity with full receipt counts as ok", () => {
  assert.equal(parseTakeResponse(502, {}).kind, "unknown");
  assert.equal(parseTakeResponse(200, { code: 200, data: {} }).kind, "unknown");
  assert.equal(parseTakeResponse(200, { code: 200, data: { voucher_identity: { coupon_id: 12 } } }).kind, "unknown");
  assert.equal(parseTakeResponse(200, { code: 141502, success: false }).kind, "rejected");
  const ok = parseTakeResponse(200, { code: 200, data: { voucher_identity: {
    coupon_id: 12, verify_code: "YZVC9", valid_start_time: 1760745600, valid_end_time: 1768521599 } } });
  assert.equal(ok.kind, "ok");
  if (ok.kind === "ok") {
    assert.equal(ok.receipt.couponId, "12");
    assert.equal(ok.receipt.verifyCode, "YZVC9");
    assert.equal(ok.receipt.validStart, "2025-10-18T00:00:00.000Z");
    assert.equal(ok.receipt.validEnd, "2026-01-15T23:59:59.000Z");
  }
  // 顶层 id / verify_code 不再被当作券 ID
  assert.equal(parseTakeResponse(200, { code: 200, data: { id: 99, verify_code: "X" } }).kind, "unknown");
});

test("query response: exact match on yz_open_id + activity_id + verify_code with full receipt", () => {
  const page = { code: 200, data: { total: 2, vouchers: [
    { user_identity: { yz_open_id: "yz" }, activity_id: 35074448,
      voucher_identity: { coupon_id: "111", verify_code: "ncvaaa", valid_start_time: 1760745600, valid_end_time: 1768521599 } },
    { user_identity: { yz_open_id: "yz" }, activity_id: "35074448",
      voucher_identity: { coupon_id: "222", verify_code: "ncvbbb", valid_start_time: 1760745600, valid_end_time: 1768521599 } },
  ] } };
  const hit = parseQueryResponse(200, page, { yzOpenId: "yz", activityId: "35074448", verifyCode: "ncvbbb" });
  assert.equal(hit.kind, "found");
  if (hit.kind === "found") assert.equal(hit.receipt.couponId, "222");
  // 同活动但 verify_code 不同（另一槽的券）不得用来补
  assert.equal(parseQueryResponse(200, page, { yzOpenId: "yz", activityId: "35074448", verifyCode: "ncvccc" }).kind, "not_found");
  assert.equal(parseQueryResponse(200, page, { yzOpenId: "other", activityId: "35074448", verifyCode: "ncvbbb" }).kind, "not_found");
  assert.equal(parseQueryResponse(500, {}, { yzOpenId: "yz", activityId: "a", verifyCode: "v" }).kind, "unavailable");
  assert.equal(parseQueryResponse(200, { code: 12345 }, { yzOpenId: "yz", activityId: "a", verifyCode: "v" }).kind, "unavailable");
});

function mirrorDeps(o: Partial<MirrorSyncDeps> = {}) {
  const updates: unknown[] = [];
  const d: MirrorSyncDeps = {
    syncEnabled: () => true,
    listActiveMirrors: async () => [{
      id: "m1", code: "YZVC001", external_id: "Y1",
      metadata: { activity_id: "35074448", yz_open_id: "yz", verify_code: "ncvaaa" } }],
    queryHeldByVerifyCode: async () => ({ kind: "found", couponId: "Y1", youzanStatus: "used" }),
    updateMirrorStatus: async (...a) => { updates.push(a); },
    ...o,
  };
  return { d, updates };
}

test("mirror sync maps used/expired/void, skips unknown and active", async () => {
  const a = mirrorDeps();
  assert.deepEqual(await syncYouzanCouponMirrors(a.d), { enabled: true, checked: 1, updated: 1 });
  assert.deepEqual(a.updates[0], ["m1", "used"]);
  const b = mirrorDeps({ queryHeldByVerifyCode: async () => ({ kind: "found", couponId: "Y1", youzanStatus: "active" }) });
  assert.equal((await syncYouzanCouponMirrors(b.d)).updated, 0);
  const c = mirrorDeps({ queryHeldByVerifyCode: async () => ({ kind: "unavailable" }) });
  assert.equal((await syncYouzanCouponMirrors(c.d)).updated, 0);
});
test("mirror sync: coupon id mismatch or missing metadata never updates", async () => {
  const a = mirrorDeps({ queryHeldByVerifyCode: async () => ({ kind: "found", couponId: "OTHER", youzanStatus: "used" }) });
  assert.equal((await syncYouzanCouponMirrors(a.d)).updated, 0);
  const b = mirrorDeps({ listActiveMirrors: async () => [{ id: "m2", code: "x", external_id: "Y2", metadata: {} }] });
  assert.equal((await syncYouzanCouponMirrors(b.d)).updated, 0);
});
test("mirror sync disabled does nothing", async () => {
  const { d, updates } = mirrorDeps({ syncEnabled: () => false });
  assert.equal((await syncYouzanCouponMirrors(d)).enabled, false);
  assert.equal(updates.length, 0);
});
