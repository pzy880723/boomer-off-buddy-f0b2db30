/**
 * 退款意图执行 worker（依赖注入，便于纯测试）。
 *
 * - 生产执行默认关闭：deps.enabled=false 时**不认领、不调用 provider**，
 *   直接返回明确的不可执行状态，前端不得据此显示成功。
 * - 认领走数据库租约 + SKIP LOCKED：重复 worker 不会同时处理同一意图。
 * - 单笔立即执行（客户确认后）与后台补偿共用同一路径与同一 merchant_refund_no。
 */
import {
  decideSettlement,
  type ExecuteOutcome,
  type IntentState,
} from "@/lib/shortage-refund/worker-policy";

export type RefundIntentRow = {
  id: string;
  shortage_id: string;
  order_id: string;
  customer_id: string;
  payment_id: string;
  after_sale_id: string | null;
  amount_fen: number;
  idempotency_key: string;
  attempts: number;
  lease_token: string;
};

export type RefundWorkerDeps = {
  /** 生产开关；默认关闭。 */
  enabled: boolean;
  claim(limit: number): Promise<RefundIntentRow[]>;
  claimById(intentId: string): Promise<RefundIntentRow | null>;
  execute(intent: RefundIntentRow): Promise<ExecuteOutcome>;
  settle(input: {
    intentId: string;
    leaseToken: string;
    state: IntentState;
    error: string | null;
    refundId: string | null;
    retryDelaySeconds: number;
  }): Promise<void>;
};

export type RunSummary = {
  ok: boolean;
  code?: string;
  attempted: number;
  succeeded: number;
  pending: number;
  failed: number;
};

export const WORKER_DISABLED_CODE = "refund_worker_disabled";

async function processOne(deps: RefundWorkerDeps, intent: RefundIntentRow): Promise<IntentState> {
  let outcome: ExecuteOutcome;
  try {
    outcome = await deps.execute(intent);
  } catch (error) {
    // 抛错一律视为「远端结果未知」：保持在途，下一轮先查询。
    outcome = { kind: "unknown", message: String((error as Error)?.message ?? error).slice(0, 300) };
  }
  const settlement = decideSettlement(outcome, intent.attempts);
  await deps.settle({
    intentId: intent.id,
    leaseToken: intent.lease_token,
    state: settlement.state,
    error: settlement.error,
    refundId: outcome.refundId ?? null,
    retryDelaySeconds: settlement.retryDelaySeconds,
  });
  return settlement.state;
}

function tally(states: IntentState[]): Omit<RunSummary, "ok" | "code"> {
  return {
    attempted: states.length,
    succeeded: states.filter((s) => s === "succeeded").length,
    pending: states.filter((s) => s === "processing" || s === "queued").length,
    failed: states.filter((s) => s === "failed" || s === "manual_review").length,
  };
}

/** 后台批量执行（systemd/cron 调用）。 */
export async function runRefundIntents(deps: RefundWorkerDeps, limit = 5): Promise<RunSummary> {
  if (!deps.enabled) {
    return { ok: false, code: WORKER_DISABLED_CODE, attempted: 0, succeeded: 0, pending: 0, failed: 0 };
  }
  const intents = await deps.claim(limit);
  const states: IntentState[] = [];
  for (const intent of intents) states.push(await processOne(deps, intent));
  const counts = tally(states);
  return { ok: counts.failed === 0, ...counts };
}

/** 客户确认后立刻尝试同一意图；进程崩溃由后台 worker 恢复。 */
export async function runRefundIntentNow(
  deps: RefundWorkerDeps,
  intentId: string,
): Promise<{ ok: boolean; code?: string; state?: IntentState }> {
  if (!deps.enabled) return { ok: false, code: WORKER_DISABLED_CODE };
  const intent = await deps.claimById(intentId);
  // 认领不到 = 已被其他 worker 持有或已终态，交给后台补偿，不重复发单。
  if (!intent) return { ok: false, code: "intent_not_claimable" };
  const state = await processOne(deps, intent);
  return { ok: state === "succeeded" || state === "processing", state };
}
