import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  STOREFRONT_CORS,
  authenticateStorefrontUser,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";
import { storefrontPaymentGatewayConfig } from "@/server/storefront-payment.server";

const CreatePaymentBody = z.object({
  order_id: z.string().uuid(),
  provider: z.enum(["wechat", "alipay"]),
  client_context: z
    .object({
      platform: z.enum(["app", "miniapp", "web"]),
      openid: z.string().trim().min(1).max(200).optional(),
      return_url: z.string().url().optional(),
    })
    .default({ platform: "app" }),
});

const GatewayResponse = z.object({
  transaction_id: z.string().trim().min(1).max(200),
  payment_payload: z.record(z.string(), z.unknown()),
  expires_at: z.string().datetime().optional(),
});

export const Route = createFileRoute("/api/public/storefront/payments")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateStorefrontUser(request);
        if (!auth.ok) return auth.response;
        const idempotencyKey = request.headers.get("idempotency-key")?.trim();
        if (!idempotencyKey) return storefrontError("Missing Idempotency-Key", 400);

        let body: z.infer<typeof CreatePaymentBody>;
        try {
          body = CreatePaymentBody.parse(await request.json());
        } catch (error) {
          return storefrontError(`Invalid request: ${String(error)}`, 400);
        }

        const { data: order, error: orderError } = await supabaseAdmin
          .from("commerce_orders" as never)
          .select(
            "id,order_no,user_id,payment_status,order_status,total_amount,currency,reservation_expires_at",
          )
          .eq("id", body.order_id)
          .eq("user_id", auth.user.id)
          .maybeSingle();
        if (orderError) return storefrontError(orderError.message, 500);
        if (!order) return storefrontError("Order not found", 404);
        const orderRow = order as unknown as {
          id: string;
          order_no: string;
          payment_status: string;
          order_status: string;
          total_amount: number;
          currency: string;
          reservation_expires_at: string;
        };
        if (orderRow.payment_status === "paid") {
          return storefrontError("Order is already paid", 409, "already_paid");
        }
        if (
          orderRow.order_status !== "pending_payment" ||
          new Date(orderRow.reservation_expires_at).getTime() <= Date.now()
        ) {
          return storefrontError("Order is no longer payable", 409, "order_not_payable");
        }

        const { data: replay } = await supabaseAdmin
          .from("commerce_payments" as never)
          .select(
            "id,order_id,provider,status,amount,currency,provider_transaction_id,payment_payload,expires_at,created_at",
          )
          .eq("provider", body.provider)
          .eq("idempotency_key", idempotencyKey)
          .maybeSingle();
        if (replay) {
          const replayRow = replay as unknown as {
            payment_payload: Record<string, unknown>;
            expires_at: string | null;
            [key: string]: unknown;
          };
          const { payment_payload, expires_at, ...payment } = replayRow;
          return storefrontJson({
            ok: true,
            data: {
              payment,
              payment_payload,
              expires_at: expires_at ?? orderRow.reservation_expires_at,
            },
            replayed: true,
          });
        }

        const config = storefrontPaymentGatewayConfig();
        if (!config.configured || !config.url || !config.token) {
          return storefrontError(
            "Payment gateway is not configured",
            503,
            "payment_not_configured",
          );
        }

        const callbackUrl = `${new URL(request.url).origin}/api/public/storefront/payments/callback/${body.provider}`;
        const gatewayResponse = await fetch(`${config.url}/v1/payments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.token}`,
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            provider: body.provider,
            merchant_order_no: orderRow.order_no,
            amount: Number(orderRow.total_amount),
            currency: orderRow.currency,
            description: `BOOMER OFF ${orderRow.order_no}`,
            notify_url: callbackUrl,
            client_context: body.client_context,
          }),
        });
        if (!gatewayResponse.ok) {
          return storefrontError(
            `Payment gateway unavailable (HTTP ${gatewayResponse.status})`,
            502,
            "payment_gateway_error",
          );
        }
        let gateway;
        try {
          gateway = GatewayResponse.parse(await gatewayResponse.json());
        } catch (error) {
          return storefrontError(`Invalid payment gateway response: ${String(error)}`, 502);
        }

        const { data: payment, error: paymentError } = await supabaseAdmin
          .from("commerce_payments" as never)
          .insert({
            order_id: orderRow.id,
            provider: body.provider,
            status: "processing",
            amount: Number(orderRow.total_amount),
            currency: orderRow.currency,
            provider_transaction_id: gateway.transaction_id,
            idempotency_key: idempotencyKey,
            payment_payload: gateway.payment_payload,
            expires_at: gateway.expires_at ?? orderRow.reservation_expires_at,
          } as never)
          .select("id,order_id,provider,status,amount,currency,provider_transaction_id,created_at")
          .single();
        if (paymentError) return storefrontError(paymentError.message, 500);
        return storefrontJson(
          {
            ok: true,
            data: {
              payment,
              payment_payload: gateway.payment_payload,
              expires_at: gateway.expires_at ?? orderRow.reservation_expires_at,
            },
          },
          { status: 201 },
        );
      },
    },
  },
});
