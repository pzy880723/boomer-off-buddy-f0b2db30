/**
 * 退款执行 worker 的纯决策逻辑（无 IO，可单测）。
 *
 * 铁律：
 * - 远端结果未知（超时/断网）绝不当作失败，也绝不发起第二笔退款单；
 *   下一轮必须先用同一 merchant_refund_no 查询再决定。
 * - provider 明确 SUCCESS 才能写 succeeded。
 * - provider 明确异常（ABNORMAL）不自动重发新单，转人工。
 * - 重试次数用尽 → manual_review，不会无限自动重试。
 */

export const MAX_REFUND_ATTEMPTS = 8;

export type ExecuteOutcomeKind =
  | "succeeded"
  | "processing"
  | "failed"
  | "cancelled"
  | "unknown"
  | "blocked";

export type ExecuteOutcome = {
  kind: ExecuteOutcomeKind;
  message?: string;
  refundId?: string | null;
};

export type IntentState = "queued" | "processing" | "succeeded" | "failed" | "manual_review";

export type Settlement = {
  state: IntentState;
  retryDelaySeconds: number;
  error: string | null;
};

/** 指数退避：60s 起，封顶 1 小时。 */
export function backoffSeconds(attempts: number): number {
  const n = Math.max(Math.floor(attempts) - 1, 0);
  return Math.min(60 * 2 ** Math.min(n, 10), 3600);
}

export function decideSettlement(outcome: ExecuteOutcome, attempts: number): Settlement {
  const delay = backoffSeconds(attempts);
  const exhausted = attempts >= MAX_REFUND_ATTEMPTS;
  switch (outcome.kind) {
    case "succeeded":
      return { state: "succeeded", retryDelaySeconds: 0, error: null };
    case "processing":
      return exhausted
        ? { state: "manual_review", retryDelaySeconds: 0, error: outcome.message ?? "provider_processing_timeout" }
        : { state: "processing", retryDelaySeconds: delay, error: null };
    case "unknown":
      // 未知结果：保持在途，下一轮先查询原退款号，绝不重发新单。
      return exhausted
        ? { state: "manual_review", retryDelaySeconds: 0, error: outcome.message ?? "provider_result_unknown" }
        : { state: "processing", retryDelaySeconds: delay, error: outcome.message ?? "provider_result_unknown" };
    case "failed":
      // provider 明确异常：不自动重发，转人工。
      return { state: "manual_review", retryDelaySeconds: 0, error: outcome.message ?? "provider_refund_abnormal" };
    case "cancelled":
      return { state: "failed", retryDelaySeconds: 0, error: outcome.message ?? "provider_refund_closed" };
    case "blocked":
    default:
      return { state: "manual_review", retryDelaySeconds: 0, error: outcome.message ?? "refund_blocked" };
  }
}
