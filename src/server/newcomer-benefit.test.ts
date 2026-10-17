import { test } from "node:test";
import assert from "node:assert/strict";
import { processNewcomerSlot, runNewcomerWorker, parseTakeResponse, type NewcomerClaim, type NewcomerDeps } from "./newcomer-benefit.server";

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
test("missing trusted mapping blocks", async () => {
  const { d, takes } = deps({ resolveMember: async () => ({ blocked: "trusted_member_mapping_missing" }) });
  assert.equal(await processNewcomerSlot(claim(), d), "blocked"); assert.equal(takes(), 0);
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
test("reconcile found records success; not_found allows refill", async () => {
  const a = deps({ queryHeld: async () => ({ kind: "found", couponId: "Y9" }) });
  assert.equal(await processNewcomerSlot(claim({ mode: "reconcile" }), a.d), "succeeded");
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
test("response parsing", () => {
  assert.equal(parseTakeResponse(502, {}).kind, "unknown");
  assert.equal(parseTakeResponse(200, { code: 200, data: {} }).kind, "unknown");
  assert.equal(parseTakeResponse(200, { code: 141502, success: false }).kind, "rejected");
  assert.deepEqual(parseTakeResponse(200, { code: 200, data: { coupon_id: 12 } }), { kind: "ok", couponId: "12" });
});
