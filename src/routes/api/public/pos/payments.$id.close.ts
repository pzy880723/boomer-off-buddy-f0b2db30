import { createFileRoute } from "@tanstack/react-router";
import { isClosablePosPaymentStatus } from "@/lib/pos/pos-scan-payment";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";
import {
  attemptResponse,
  finalizePaidAttempt,
  findAttemptById,
  markAttemptStatus,
  resolveStoreMerchant,
} from "@/server/pos-payment.server";
import {
  alipayQuery,
  providerConfigured,
  wechatQuery,
  type AlipayConfig,
  type WechatConfig,
} from "@/server/pos-payment-provider.server";

export const Route = createFileRoute("/api/public/pos/payments/$id/close")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      POST: async ({ request, params }) => {
        const attempt = await findAttemptById(params.id);
        if (!attempt) return posError("支付流水不存在", 404, "payment_not_found");
        const auth = await authenticatePosUser(request, attempt.location_id);
        if (!auth.ok) return auth.response;
        if (!isClosablePosPaymentStatus(attempt.status)) {
          return posError("该支付流水已结束，不能关闭", 409, "payment_not_closable");
        }

        // 关闭前先查一次，避免用户其实已经付款成功却被误关
        const config = providerConfigured(attempt.provider);
        const merchant = await resolveStoreMerchant(attempt.location_id, attempt.provider);
        if (config.ok && merchant.ok) {
          const queried =
            attempt.provider === "wechat"
              ? await wechatQuery({
                  config: config.config as WechatConfig,
                  subMchId: merchant.merchant.wechatSubMchId!,
                  outTradeNo: attempt.out_trade_no,
                })
              : await alipayQuery({
                  config: config.config as AlipayConfig,
                  outTradeNo: attempt.out_trade_no,
                });
          if (queried.status === "paid" && queried.providerTransactionId) {
            const paid = await finalizePaidAttempt(attempt, {
              providerTransactionId: queried.providerTransactionId,
              providerResponse: queried.raw,
            });
            return posJson({ ok: true, data: await attemptResponse(paid) });
          }
        }

        const closed = await markAttemptStatus(attempt, "closed", {
          error_code: "closed_by_cashier",
          error_message: "收银员已取消本次收款",
        });
        return posJson({ ok: true, data: await attemptResponse(closed) });
      },
    },
  },
});
