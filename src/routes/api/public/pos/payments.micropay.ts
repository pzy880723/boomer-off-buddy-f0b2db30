import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { detectAuthCodeProvider } from "@/lib/pos/pos-scan-payment";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";
import {
  attemptResponse,
  createAttempt,
  finalizePaidAttempt,
  findAttemptByClientOpId,
  markAttemptStatus,
  recomputePayableAmount,
  resolveStoreMerchant,
} from "@/server/pos-payment.server";
import {
  alipayMicropay,
  providerConfigured,
  wechatMicropay,
  type AlipayConfig,
  type WechatConfig,
} from "@/server/pos-payment-provider.server";

const MicropayBody = z.object({
  location_id: z.string().uuid(),
  shift_id: z.string().uuid(),
  provider: z.enum(["wechat", "alipay"]),
  auth_code: z.string().trim().min(16).max(24),
  client_op_id: z.string().trim().min(8).max(100),
  items: z
    .array(z.object({ sku_id: z.string().uuid(), quantity: z.number().int().min(1).max(999) }))
    .min(1)
    .max(100),
  customer_id: z.string().uuid().optional(),
  note: z.string().trim().max(500).optional(),
  authorization_id: z.string().uuid().optional(),
  discount: z
    .object({
      type: z.enum(["amount", "percentage", "final_price"]),
      value: z.number().nonnegative(),
      reason: z.string().trim().min(2).max(200),
    })
    .optional(),
});

export const Route = createFileRoute("/api/public/pos/payments/micropay")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      POST: async ({ request }) => {
        const parsed = MicropayBody.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return posError("参数错误", 400, "invalid_request");
        const body = parsed.data;

        const detected = detectAuthCodeProvider(body.auth_code);
        if (!detected) return posError("付款码不合法", 422, "auth_code_invalid");
        if (detected !== body.provider) {
          return posError("付款码与所选支付方式不一致", 422, "auth_code_provider_mismatch");
        }

        const auth = await authenticatePosUser(request, body.location_id);
        if (!auth.ok) return auth.response;

        const existing = await findAttemptByClientOpId(body.client_op_id);
        if (existing) return posJson({ ok: true, data: await attemptResponse(existing) });

        const { data: shift, error: shiftError } = await supabaseAdmin
          .from("pos_shifts" as never)
          .select("id,location_id,operator_id,status")
          .eq("id", body.shift_id)
          .maybeSingle();
        if (shiftError) return posError(shiftError.message, 500);
        const shiftRow = shift as unknown as {
          location_id: string;
          operator_id: string;
          status: string;
        } | null;
        if (!shiftRow) return posError("收银班次不存在", 404, "shift_not_found");
        if (shiftRow.status !== "open") return posError("收银班次未开启", 409, "shift_closed");
        if (shiftRow.location_id !== body.location_id) {
          return posError("班次不属于该门店", 403, "shift_forbidden");
        }
        if (shiftRow.operator_id !== auth.user.id) {
          return posError("不能使用其他员工的班次", 403, "shift_forbidden");
        }

        const merchant = await resolveStoreMerchant(body.location_id, body.provider);
        if (!merchant.ok) {
          return posError(merchant.failure.message, merchant.failure.status, merchant.failure.code);
        }
        const config = providerConfigured(body.provider);
        if (!config.ok) {
          return posError(
            "该支付方式尚未在服务端完成配置，暂时无法收款",
            503,
            "payment_not_configured",
          );
        }

        const amount = await recomputePayableAmount({
          locationId: body.location_id,
          items: body.items,
          discount: body.discount,
        });
        if (!amount.ok) {
          return posError(amount.failure.message, amount.failure.status, amount.failure.code);
        }

        const attempt = await createAttempt({
          locationId: body.location_id,
          shiftId: body.shift_id,
          operatorId: auth.user.id,
          provider: body.provider,
          mode: "merchant_scan",
          amount: amount.payable_total,
          clientOpId: body.client_op_id,
          customerId: body.customer_id ?? null,
          merchant: merchant.merchant,
          authCode: body.auth_code,
          salePayload: {
            items: body.items,
            discount: body.discount ?? null,
            authorization_id: body.authorization_id ?? null,
            note: body.note ?? null,
          },
        });

        const charge =
          body.provider === "wechat"
            ? await wechatMicropay({
                config: config.config as WechatConfig,
                subMchId: merchant.merchant.wechatSubMchId!,
                subAppId: merchant.merchant.wechatSubAppId,
                outTradeNo: attempt.out_trade_no,
                amount: attempt.amount,
                authCode: body.auth_code,
                description: amount.description,
              })
            : await alipayMicropay({
                config: config.config as AlipayConfig,
                outTradeNo: attempt.out_trade_no,
                amount: attempt.amount,
                authCode: body.auth_code,
                subject: amount.description,
                sellerId: merchant.merchant.alipaySellerId,
              });

        if (charge.status === "paid" && charge.providerTransactionId) {
          const paid = await finalizePaidAttempt(attempt, {
            providerTransactionId: charge.providerTransactionId,
            providerResponse: charge.raw,
          });
          return posJson({ ok: true, data: await attemptResponse(paid) });
        }

        const next = await markAttemptStatus(attempt, charge.status, {
          error_code: charge.errorCode,
          error_message: charge.message,
          provider_response: charge.raw,
        });
        return posJson({ ok: true, data: await attemptResponse(next) });
      },
    },
  },
});
