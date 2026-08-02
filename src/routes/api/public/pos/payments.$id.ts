import { createFileRoute } from "@tanstack/react-router";
import { isPosPaymentExpired, isTerminalPosPaymentStatus } from "@/lib/pos/pos-scan-payment";
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

export const Route = createFileRoute("/api/public/pos/payments/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      GET: async ({ request, params }) => {
        if (!/^[0-9a-f-]{36}$/i.test(params.id)) {
          return posError("支付流水不存在", 404, "payment_not_found");
        }
        const attempt = await findAttemptById(params.id);
        if (!attempt) return posError("支付流水不存在", 404, "payment_not_found");
        const auth = await authenticatePosUser(request, attempt.location_id);
        if (!auth.ok) return auth.response;

        if (isTerminalPosPaymentStatus(attempt.status)) {
          return posJson({ ok: true, data: await attemptResponse(attempt) });
        }
        if (isPosPaymentExpired(attempt.expires_at)) {
          const expired = await markAttemptStatus(attempt, "expired", {
            error_code: "expired",
            error_message: "二维码已过期",
          });
          return posJson({ ok: true, data: await attemptResponse(expired) });
        }

        const config = providerConfigured(attempt.provider);
        const merchant = await resolveStoreMerchant(attempt.location_id, attempt.provider);
        if (!config.ok || !merchant.ok) {
          return posJson({ ok: true, data: await attemptResponse(attempt) });
        }
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
        const next = await markAttemptStatus(attempt, queried.status, {
          error_message: queried.message,
        });
        return posJson({ ok: true, data: await attemptResponse(next) });
      },
    },
  },
});
