import { createFileRoute } from "@tanstack/react-router";
import {
  callbackAmountMatches,
  mapAlipayTradeStatus,
  mapWechatTradeState,
} from "@/lib/pos/pos-scan-payment";
import {
  finalizePaidAttempt,
  findAttemptByOutTradeNo,
  markAttemptStatus,
  resolveStoreMerchant,
} from "@/server/pos-payment.server";
import {
  providerConfigured,
  verifyAlipayCallback,
  verifyWechatCallback,
  type AlipayConfig,
  type WechatConfig,
} from "@/server/pos-payment-provider.server";

function wechatReply(code: "SUCCESS" | "FAIL", message: string, status = 200) {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function alipayReply(body: "success" | "failure", status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

export const Route = createFileRoute("/api/public/pos/payments/callback/$provider")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const provider = params.provider;
        if (provider !== "wechat" && provider !== "alipay") {
          return new Response("unsupported provider", { status: 404 });
        }
        const config = providerConfigured(provider);
        if (!config.ok) {
          return provider === "wechat"
            ? wechatReply("FAIL", "payment_not_configured", 503)
            : alipayReply("failure", 503);
        }
        const rawBody = await request.text();

        if (provider === "wechat") {
          const verified = await verifyWechatCallback({
            config: config.config as WechatConfig,
            headers: request.headers,
            rawBody,
          });
          if (!verified.ok) return wechatReply("FAIL", "signature_invalid", 401);
          const resource = verified.resource;
          const outTradeNo = String(resource["out_trade_no"] ?? "");
          const attempt = outTradeNo ? await findAttemptByOutTradeNo(outTradeNo) : null;
          if (!attempt) return wechatReply("FAIL", "order_not_found", 404);
          const amountMinor = Number(
            (resource["amount"] as { total?: number } | undefined)?.total ?? -1,
          );
          if (!callbackAmountMatches(Number(attempt.amount), amountMinor)) {
            return wechatReply("FAIL", "amount_mismatch", 422);
          }
          const merchant = await resolveStoreMerchant(attempt.location_id, "wechat");
          const subMchId = String(resource["sp_mchid"] ?? resource["sub_mchid"] ?? "");
          if (
            merchant.ok &&
            merchant.merchant.wechatSubMchId &&
            subMchId &&
            subMchId !== merchant.merchant.wechatSubMchId &&
            subMchId !== (config.config as WechatConfig).mchId
          ) {
            return wechatReply("FAIL", "merchant_mismatch", 422);
          }
          const status = mapWechatTradeState(resource["trade_state"] as string);
          if (status === "paid") {
            await finalizePaidAttempt(attempt, {
              providerTransactionId: String(resource["transaction_id"] ?? ""),
              paidAt: (resource["success_time"] as string) ?? undefined,
              providerResponse: resource,
            });
          } else {
            await markAttemptStatus(attempt, status);
          }
          return wechatReply("SUCCESS", "OK");
        }

        const params_ = Object.fromEntries(new URLSearchParams(rawBody).entries());
        const signed = await verifyAlipayCallback({
          config: config.config as AlipayConfig,
          params: params_,
        });
        if (!signed) return alipayReply("failure", 401);
        const attempt = await findAttemptByOutTradeNo(params_["out_trade_no"] ?? "");
        if (!attempt) return alipayReply("failure", 404);
        const amountMinor = Math.round(Number(params_["total_amount"] ?? 0) * 100);
        if (!callbackAmountMatches(Number(attempt.amount), amountMinor)) {
          return alipayReply("failure", 422);
        }
        const merchant = await resolveStoreMerchant(attempt.location_id, "alipay");
        const sellerId = params_["seller_id"] ?? "";
        if (merchant.ok && merchant.merchant.alipaySellerId && sellerId && sellerId !== merchant.merchant.alipaySellerId) {
          return alipayReply("failure", 422);
        }
        const status = mapAlipayTradeStatus(params_["trade_status"] ?? null);
        if (status === "paid") {
          await finalizePaidAttempt(attempt, {
            providerTransactionId: params_["trade_no"] ?? "",
            paidAt: params_["gmt_payment"] ?? undefined,
            providerResponse: params_,
          });
        } else {
          await markAttemptStatus(attempt, status);
        }
        return alipayReply("success");
      },
    },
  },
});
