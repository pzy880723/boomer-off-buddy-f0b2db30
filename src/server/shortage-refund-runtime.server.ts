/**
 * 退款 worker 的生产依赖：内嵌 Supabase 租约 RPC + 原普通微信支付通道。
 *
 * - 授权来自「客户已确认的退款意图」，不伪造 HQ 角色；HQ 审批入口保持不变。
 * - 通道以原支付记录 payment_channel/merchant_snapshot 为准，绝不按当前全局开关重解释历史订单。
 * - 生产执行默认关闭（SHORTAGE_REFUND_WORKER_ENABLED=true 才执行）。
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ordinaryPaymentRuntime } from "./ordinary-payment.server";
import { executeOrdinaryRefund } from "./ordinary-refund-flow";
import type { ExecuteOutcome } from "@/lib/shortage-refund/worker-policy";
import type { RefundIntentRow, RefundWorkerDeps } from "./refund-intent-worker.server";

export const LEASE_SECONDS = 120;

export function refundWorkerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env["SHORTAGE_REFUND_WORKER_ENABLED"] ?? "").trim() === "true";
}

const BLOCKING = /mismatch|not refundable|not approved|exceeds|idempotency|permission|snapshot/i;

function asIntents(data: unknown): RefundIntentRow[] {
  const rows = Array.isArray(data) ? data : [];
  return rows as RefundIntentRow[];
}

export function createRefundWorkerDeps(
  env: Record<string, string | undefined> = process.env,
): RefundWorkerDeps {
  return {
    enabled: refundWorkerEnabled(env),
    async claim(limit) {
      const { data, error } = await supabaseAdmin.rpc("commerce_claim_refund_intents" as never, {
        p_limit: limit,
        p_lease_seconds: LEASE_SECONDS,
      } as never);
      if (error) throw new Error(error.message);
      return asIntents(data);
    },
    async claimById(intentId) {
      const { data, error } = await supabaseAdmin.rpc("commerce_claim_refund_intent" as never, {
        p_intent_id: intentId,
        p_lease_seconds: LEASE_SECONDS,
      } as never);
      if (error) throw new Error(error.message);
      return asIntents(data)[0] ?? null;
    },
    async execute(intent): Promise<ExecuteOutcome> {
      if (!intent.after_sale_id) return { kind: "blocked", message: "after_sale_missing" };
      const { data: payment } = await supabaseAdmin
        .from("commerce_payments" as never)
        .select("id, payment_channel")
        .eq("id", intent.payment_id)
        .maybeSingle();
      const channel = (payment as { payment_channel?: string } | null)?.payment_channel;
      if (channel !== "ordinary_wechat") {
        return { kind: "blocked", message: `unsupported_refund_channel:${channel ?? "unknown"}` };
      }
      try {
        const result = await executeOrdinaryRefund(ordinaryPaymentRuntime(), {
          paymentId: intent.payment_id,
          afterSaleId: intent.after_sale_id,
          // 账本的 requested_by 记录发起主体；客户确认的退款由退款意图标识，绝不冒充 HQ 员工。
          operatorId: intent.customer_id,
          idempotencyKey: intent.idempotency_key,
        });
        const status = String(result.status);
        if (status === "succeeded") return { kind: "succeeded", refundId: result.id };
        if (status === "failed") return { kind: "failed", refundId: result.id, message: "provider_refund_abnormal" };
        if (status === "cancelled") return { kind: "cancelled", refundId: result.id, message: "provider_refund_closed" };
        return { kind: "processing", refundId: result.id };
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        // 账本/快照类拒绝是确定性失败 → 人工；其余（网络、超时）留给 worker 视作未知结果。
        if (BLOCKING.test(message)) return { kind: "blocked", message: message.slice(0, 300) };
        throw error;
      }
    },
    async settle(input) {
      const { error } = await supabaseAdmin.rpc("commerce_settle_refund_intent" as never, {
        p_intent_id: input.intentId,
        p_lease_token: input.leaseToken,
        p_state: input.state,
        p_error: input.error,
        p_refund_id: input.refundId,
        p_retry_delay_seconds: input.retryDelaySeconds,
      } as never);
      if (error) throw new Error(error.message);
    },
  };
}

/**
 * 客户确认后立即尝试同一退款意图；进程崩溃或未开启时由后台 worker 补偿。
 * 任何失败都不抛给客户：确认事实已入库，执行状态由 refund_state 反映。
 */
export async function kickShortageRefund(shortageId: string): Promise<void> {
  try {
    const { data } = await supabaseAdmin
      .from("commerce_refund_intents" as never)
      .select("id")
      .eq("shortage_id", shortageId)
      .maybeSingle();
    const intentId = (data as { id?: string } | null)?.id;
    if (!intentId) return;
    const { runRefundIntentNow } = await import("./refund-intent-worker.server");
    await runRefundIntentNow(createRefundWorkerDeps(), intentId);
  } catch {
    /* 后台 worker 会重试；此处绝不向客户报告假成功或假失败 */
  }
}
