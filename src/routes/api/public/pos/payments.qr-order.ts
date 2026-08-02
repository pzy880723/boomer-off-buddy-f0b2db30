import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";
import {
  attemptResponse,
  createAttempt,
  findAttemptByClientOpId,
  markAttemptStatus,
  recomputePayableAmount,
  resolveStoreMerchant,
  updateAttempt,
} from "@/server/pos-payment.server";
import {
  alipayPrecreate,
  providerConfigured,
  wechatNative,
  type AlipayConfig,
  type WechatConfig,
} from "@/server/pos-payment-provider.server";

const QR_TIMEOUT_MINUTES = 5;

const QrOrderBody = z.object({
  location_id: z.string().uuid(),
  shift_id: z.string().uuid(),
  provider: z.enum(["wechat", "alipay"]),
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

export const Route = createFileRoute("/api/public/pos/payments/qr-order")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      POST: async ({ request }) => {
        const parsed = QrOrderBody.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return posError("参数错误", 400, "invalid_request");
        const body = parsed.data;

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

        const expiresAt = new Date(Date.now() + QR_TIMEOUT_MINUTES * 60 * 1000);
        const attempt = await createAttempt({
          locationId: body.location_id,
          shiftId: body.shift_id,
          operatorId: auth.user.id,
          provider: body.provider,
          mode: "customer_scan",
          amount: amount.payable_total,
          clientOpId: body.client_op_id,
          customerId: body.customer_id ?? null,
          merchant: merchant.merchant,
          expiresAt,
          salePayload: {
            items: body.items,
            discount: body.discount ?? null,
            authorization_id: body.authorization_id ?? null,
            note: body.note ?? null,
          },
        });

        // 只使用订单专属动态码，绝不下发门店静态收款码
        const order =
          body.provider === "wechat"
            ? await wechatNative({
                config: config.config as WechatConfig,
                subMchId: merchant.merchant.wechatSubMchId!,
                outTradeNo: attempt.out_trade_no,
                amount: attempt.amount,
                description: amount.description,
                expiresAt,
              })
            : await alipayPrecreate({
                config: config.config as AlipayConfig,
                outTradeNo: attempt.out_trade_no,
                amount: attempt.amount,
                subject: amount.description,
                timeoutMinutes: QR_TIMEOUT_MINUTES,
                sellerId: merchant.merchant.alipaySellerId,
              });

        if (order.status === "failed" || !order.qrContent) {
          const failed = await markAttemptStatus(attempt, "failed", {
            error_code: order.errorCode,
            error_message: order.message,
            provider_response: order.raw,
          });
          return posJson({ ok: true, data: await attemptResponse(failed) });
        }

        const ready = await updateAttempt(attempt.id, {
          qr_content: order.qrContent,
          code_url: order.qrContent,
          provider_response: order.raw,
        });
        return posJson({ ok: true, data: await attemptResponse(ready) }, { status: 201 });
      },
    },
  },
});
