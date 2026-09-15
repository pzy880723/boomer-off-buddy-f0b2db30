/**
 * 缺货售后路由适配层（无 HTTP 依赖，便于直接对「路由行为」断言）。
 * 路由文件只负责鉴权 + 解析 body，然后调用这里。
 */
import {
  REFUND_DISABLED_BODY,
  confirmShortageRefund,
  getShortageCase,
  type ShortageDeps,
} from "./shortage-refund.server";
import type { ShortageCase } from "@/lib/shortage-refund/case";

export type RouteResult = {
  status: number;
  body: { ok: true; data: ShortageCase } | { ok: false; error: string; code: string };
};

export type RouteEnv = {
  deps: ShortageDeps;
  /** 确认成功后立即尝试执行同一意图；未开启时返回 executed=false。 */
  kick(shortageId: string): Promise<{ executed: boolean }>;
};

/** POST /shortages/:id/confirm-refund */
export async function handleConfirmRefund(
  env: RouteEnv,
  input: { customerId: string; shortageId: string; quoteVersion: string },
): Promise<RouteResult> {
  // 未开启真实退款执行 → 在任何写入之前 503，绝不落 queued 也不伪装成功。
  if (!env.deps.refundExecutionEnabled()) {
    return { status: 503, body: REFUND_DISABLED_BODY };
  }
  const result = await confirmShortageRefund(env.deps, input);
  if (result.status !== 200) return result;
  await env.kick(input.shortageId);
  const fresh = await getShortageCase(env.deps, input.customerId, input.shortageId);
  if (fresh) return { status: 200, body: { ok: true, data: fresh } };
  return result;
}

/** POST /shortages/:id/respond（旧版小程序入口，走同一条退款意图事务） */
export async function handleRespond(
  env: RouteEnv,
  input: { customerId: string; shortageId: string },
): Promise<RouteResult> {
  const current = await getShortageCase(env.deps, input.customerId, input.shortageId);
  if (!current) {
    return { status: 404, body: { ok: false, error: "Shortage not found", code: "not_found" } };
  }
  if (!env.deps.refundExecutionEnabled()) {
    return { status: 503, body: REFUND_DISABLED_BODY };
  }
  if (!current.can_confirm || !current.quote_version) {
    // 无可验证金额 → 人工复核，绝不编造退款
    return { status: 200, body: { ok: true, data: current } };
  }
  return handleConfirmRefund(env, {
    customerId: input.customerId,
    shortageId: input.shortageId,
    quoteVersion: current.quote_version,
  });
}
