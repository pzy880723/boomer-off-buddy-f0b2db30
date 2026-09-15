import test from "node:test";
import assert from "node:assert/strict";
import {
  runRefundIntentNow,
  runRefundIntents,
  WORKER_DISABLED_CODE,
  type RefundIntentRow,
  type RefundWorkerDeps,
} from "./refund-intent-worker.server";
import { backoffSeconds, decideSettlement, MAX_REFUND_ATTEMPTS } from "@/lib/shortage-refund/worker-policy";

const intent: RefundIntentRow = {
  id: "i1",
  shortage_id: "s1",
  order_id: "o1",
  customer_id: "c1",
  payment_id: "p1",
  after_sale_id: "a1",
  amount_fen: 991,
  idempotency_key: "shortage:s1:v1",
  attempts: 1,
  lease_token: "lease-1",
};

type Settled = Parameters<RefundWorkerDeps["settle"]>[0];

function makeDeps(over: Partial<RefundWorkerDeps> = {}) {
  const settled: Settled[] = [];
  const executed: string[] = [];
  const claimed: RefundIntentRow[] = [intent];
  const deps: RefundWorkerDeps = {
    enabled: true,
    claim: async () => claimed.splice(0, claimed.length),
    claimById: async (id) => (id === intent.id ? intent : null),
    execute: async (row) => {
      executed.push(row.idempotency_key);
      return { kind: "succeeded", refundId: "r1" };
    },
    settle: async (input) => {
      settled.push(input);
    },
    ...over,
  };
  return { deps, settled, executed };
}

test("生产开关关闭时不认领、不调用 provider，返回明确不可执行状态", async () => {
  let claimedCount = 0;
  const { deps, executed } = makeDeps({
    enabled: false,
    claim: async () => {
      claimedCount += 1;
      return [intent];
    },
  });
  const run = await runRefundIntents(deps);
  assert.deepEqual(run, { ok: false, code: WORKER_DISABLED_CODE, attempted: 0, succeeded: 0, pending: 0, failed: 0 });
  const now = await runRefundIntentNow(deps, "i1");
  assert.deepEqual(now, { ok: false, code: WORKER_DISABLED_CODE });
  assert.equal(claimedCount, 0);
  assert.deepEqual(executed, []);
});

test("provider SUCCESS 才写 succeeded", async () => {
  const { deps, settled } = makeDeps();
  const run = await runRefundIntents(deps);
  assert.equal(run.succeeded, 1);
  assert.equal(settled[0]!.state, "succeeded");
  assert.equal(settled[0]!.leaseToken, "lease-1");
  assert.equal(settled[0]!.refundId, "r1");
});

test("断网/超时属于未知结果：保持在途并退避，绝不写失败也不发第二笔", async () => {
  const { deps, settled } = makeDeps({
    execute: async () => {
      throw new Error("fetch failed");
    },
  });
  const run = await runRefundIntents(deps);
  assert.equal(run.pending, 1);
  assert.equal(settled[0]!.state, "processing");
  assert.equal(settled[0]!.retryDelaySeconds, backoffSeconds(1));
  assert.match(settled[0]!.error ?? "", /fetch failed/);
});

test("provider 明确异常不自动重发新单，直接转人工", () => {
  const settlement = decideSettlement({ kind: "failed", message: "ABNORMAL" }, 1);
  assert.equal(settlement.state, "manual_review");
  assert.equal(settlement.retryDelaySeconds, 0);
});

test("重试次数用尽后停止自动重试，转人工", () => {
  const settlement = decideSettlement({ kind: "unknown" }, MAX_REFUND_ATTEMPTS);
  assert.equal(settlement.state, "manual_review");
});

test("金额/快照不匹配被账本拒绝时转人工，不重复发单", async () => {
  const { deps, settled } = makeDeps({
    execute: async () => ({ kind: "blocked", message: "Refund response mismatch" }),
  });
  const run = await runRefundIntents(deps);
  assert.equal(run.failed, 1);
  assert.equal(settled[0]!.state, "manual_review");
});

test("重复 worker：认领不到的意图不会被第二次执行", async () => {
  const { deps, executed } = makeDeps({ claimById: async () => null });
  const result = await runRefundIntentNow(deps, "i1");
  assert.deepEqual(result, { ok: false, code: "intent_not_claimable" });
  assert.deepEqual(executed, []);
});

test("客户确认后立即执行走同一幂等键与同一租约", async () => {
  const { deps, settled, executed } = makeDeps();
  const result = await runRefundIntentNow(deps, "i1");
  assert.equal(result.state, "succeeded");
  assert.deepEqual(executed, ["shortage:s1:v1"]);
  assert.equal(settled.length, 1);
});
