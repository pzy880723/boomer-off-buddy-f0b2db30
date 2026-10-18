import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveVerifyCode, mapYouzanStatus, queryPageInfo, queryHeldPagesWith,
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
    verifyIdentity: async () => ({ ok: true as const }),
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
  const page = { code: 200, total: 2, data: [
    { user_identity: { yz_open_id: "yz" }, activity_id: 35074448,
      voucher_identity: { coupon_id: "111", verify_code: "ncvaaa", valid_start_time: 1760745600, valid_end_time: 1768521599 } },
    { user_identity: { yz_open_id: "yz" }, activity_id: "35074448",
      voucher_identity: { coupon_id: "222", verify_code: "ncvbbb", valid_start_time: 1760745600, valid_end_time: 1768521599 } },
  ] };
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
    listMirrorsForSync: async () => [{
      id: "m1", code: "YZVC001", external_id: "Y1",
      metadata: { activity_id: "35074448", yz_open_id: "yz", verify_code: "ncvaaa" } }],
    queryHeldByVerifyCode: async () => ({ kind: "found", couponId: "Y1", youzanStatus: "3" }),
    applyMirrorStatus: async (...a) => { updates.push(a); return a[2] ? "updated" : "checked"; },
    ...o,
  };
  return { d, updates };
}
test("mirror sync maps used, unknown status / unavailable only stamp", async () => {
  const a = mirrorDeps();
  assert.deepEqual(await syncYouzanCouponMirrors(a.d), { enabled: true, checked: 1, updated: 1 });
  assert.deepEqual(a.updates[0], ["m1", "Y1", "used"]);
  const b = mirrorDeps({ queryHeldByVerifyCode: async () => ({ kind: "found", couponId: "Y1", youzanStatus: "weird" }) });
  await syncYouzanCouponMirrors(b.d); assert.deepEqual(b.updates[0], ["m1", "Y1", null]);
  const c = mirrorDeps({ queryHeldByVerifyCode: async () => ({ kind: "unavailable" }) });
  await syncYouzanCouponMirrors(c.d); assert.deepEqual(c.updates[0], ["m1", "Y1", null]);
});
test("mirror sync disabled does nothing", async () => {
  const { d, updates } = mirrorDeps({ syncEnabled: () => false });
  assert.equal((await syncYouzanCouponMirrors(d)).enabled, false);
  assert.equal(updates.length, 0);
});

// ---- 0093 review fixes ----
const realPage = (items: unknown[], total: number) => ({ code: 200, success: true, total, data: items });
const v = (id: string, code: string, status = 1) => ({ status, user_identity: { yz_open_id: "yz" }, activity_id: 35074448,
  voucher_identity: { coupon_id: id, verify_code: code, valid_start_time: 1760745600, valid_end_time: 1768521599 } });
test("query parser reads real top-level data array (not data.vouchers) with numeric status", () => {
  const p2 = realPage([v("901", "ncvzzz", 2), v("902", "ncvyyy", 1)], 52);
  const hit = parseQueryResponse(200, p2, { yzOpenId: "yz", activityId: "35074448", verifyCode: "ncvyyy" });
  assert.equal(hit.kind, "found");
  if (hit.kind === "found") { assert.equal(hit.receipt.couponId, "902"); assert.equal(hit.receipt.verifyCode, "ncvyyy"); assert.equal(hit.youzanStatus, "1"); }
  assert.deepEqual(queryPageInfo(p2), { total: 52, count: 2 });
});
test("queryHeldPages: page_num + activity_type_group=1 + status=0, finds exact coupon on page 2", async () => {
  const sent: Record<string, unknown>[] = [];
  const page1 = Array.from({ length: 50 }, (_, i) => v(`p1-${i}`, `ncvp1${i}`));
  const call = async (b: Record<string, unknown>) => { sent.push(b);
    return { status: 200, body: b.page_num === 1 ? realPage(page1, 51) : realPage([v("777", "ncvtarget")], 51) }; };
  const r = await queryHeldPagesWith(call, { yzOpenId: "yz", activityId: "35074448", verifyCode: "ncvtarget" });
  assert.equal(r.kind, "found"); if (r.kind === "found") assert.equal(r.receipt.couponId, "777");
  assert.equal(sent[0].page_num, 1); assert.equal(sent[1].page_num, 2);
  assert.equal(sent[0].activity_type_group, 1); assert.equal(sent[0].status, 0); assert.equal("page_no" in sent[0], false);
});
test("numeric Youzan status maps 1 active/2 frozen/3 used/4 void/5 void", () => {
  assert.equal(mapYouzanStatus("1"), "active"); assert.equal(mapYouzanStatus("2"), "frozen");
  assert.equal(mapYouzanStatus("3"), "used"); assert.equal(mapYouzanStatus("4"), "void"); assert.equal(mapYouzanStatus("5"), "void");
  assert.equal(mapYouzanStatus("9"), null);
});
test("reconcile with mapping missing stays unknown (never retry->dispatch)", async () => {
  const { d, finished } = deps({ resolveMember: async () => ({ blocked: "trusted_member_mapping_missing" }) });
  assert.equal(await processNewcomerSlot(claim({ mode: "reconcile" }), d), "unknown");
  assert.equal((finished[0] as unknown[])[2], "unknown");
});
test("resolveMember throw before any external write: dispatch retries, reconcile stays unknown", async () => {
  const a = deps({ resolveMember: async () => { throw new Error("x"); } });
  assert.equal(await processNewcomerSlot(claim(), a.d), "retry"); assert.equal(a.takes(), 0);
  const b = deps({ resolveMember: async () => { throw new Error("x"); } });
  assert.equal(await processNewcomerSlot(claim({ mode: "reconcile" }), b.d), "unknown");
});
test("mirror sync stamps every checked row (rotation) and restores frozen->active", async () => {
  const applied: unknown[] = [];
  const d: MirrorSyncDeps = {
    syncEnabled: () => true,
    listMirrorsForSync: async () => [
      { id: "m1", code: "c", external_id: "Y1", status: "frozen", metadata: { activity_id: "a", yz_open_id: "yz", verify_code: "v1" } },
      { id: "m2", code: "c", external_id: "Y2", status: "active", metadata: { activity_id: "a", yz_open_id: "yz", verify_code: "v2" } },
      { id: "m3", code: "c", external_id: "Y3", status: "active", metadata: {} }],
    queryHeldByVerifyCode: async ({ verifyCode }) => verifyCode === "v1"
      ? { kind: "found", couponId: "Y1", youzanStatus: "1" } : { kind: "found", couponId: "WRONG", youzanStatus: "3" },
    applyMirrorStatus: async (...a) => { applied.push(a); return "updated"; },
  };
  const r = await syncYouzanCouponMirrors(d);
  assert.deepEqual(applied, [["m1", "Y1", "active"], ["m2", "Y2", null], ["m3", "Y3", null]]);
  assert.equal(r.checked, 3);
});

// ---- 0094 review fixes ----
test("empty coupon_id is never ok", () => {
  assert.equal(parseTakeResponse(200, { code: 200, data: { voucher_identity: {
    coupon_id: "", verify_code: "ncv1", valid_start_time: 1760745600, valid_end_time: 1768521599 } } }).kind, "unknown");
  assert.equal(parseTakeResponse(200, { code: 200, data: { voucher_identity: {
    coupon_id: "  ", verify_code: "ncv1", valid_start_time: 1760745600, valid_end_time: 1768521599 } } }).kind, "unknown");
});
test("identity recheck blocks dispatch to changed/inactive identity before any Youzan call", async () => {
  const { d, takes, finished } = deps({ verifyIdentity: async () => ({ blocked: "phone_changed" }) });
  assert.equal(await processNewcomerSlot(claim(), d), "blocked"); assert.equal(takes(), 0);
  assert.equal((finished[0] as unknown[])[4], "phone_changed");
});
test("identity recheck unavailable: dispatch retries, reconcile stays unknown", async () => {
  const a = deps({ verifyIdentity: async () => { throw new Error("db"); } });
  assert.equal(await processNewcomerSlot(claim(), a.d), "retry"); assert.equal(a.takes(), 0);
  const b = deps({ verifyIdentity: async () => { throw new Error("db"); } });
  assert.equal(await processNewcomerSlot(claim({ mode: "reconcile" }), b.d), "unknown");
});
test("stale claim stops without sending", async () => {
  const { d, takes } = deps({ verifyIdentity: async () => ({ stale: true }) });
  assert.equal(await processNewcomerSlot(claim(), d), "stale"); assert.equal(takes(), 0);
});
test("HQ token / proxy unavailable is transient: retry, never permanent blocked", async () => {
  const a = deps({ resolveMember: async () => ({ blocked: "headquarters_token_unavailable" }) });
  assert.equal(await processNewcomerSlot(claim(), a.d), "retry");
  const b = deps({ take: async () => ({ kind: "not_sent", reason: "headquarters_token_unavailable" }) });
  assert.equal(await processNewcomerSlot(claim(), b.d), "retry");
});
test("worker claims one slot at a time with its own lease, up to limit, sequentially", async () => {
  const log: string[] = []; let n = 0;
  const { d } = deps({
    claim: async (limit) => { log.push(`claim:${limit}`); n++; return n <= 3 ? [claim({ slot_id: `s${n}` })] : []; },
    take: async () => { log.push("take:start"); await new Promise((r) => setTimeout(r, 20)); log.push("take:end");
      return { kind: "ok", receipt: receipt({ couponId: `Y${n}` }) }; },
  });
  const r = await runNewcomerWorker(d, 10);
  assert.equal(r.claimed, 3);
  assert.deepEqual(log, ["claim:1", "take:start", "take:end", "claim:1", "take:start", "take:end", "claim:1", "take:start", "take:end", "claim:1"]);
  n = 0; const log2: string[] = [];
  const e = deps({ claim: async (l) => { log2.push(`claim:${l}`); return [claim()]; } });
  assert.equal((await runNewcomerWorker(e.d, 2)).claimed, 2); assert.equal(log2.length, 2);
});
