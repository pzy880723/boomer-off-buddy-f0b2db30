import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { STOREFRONT_CORS, storefrontError, storefrontJson } from "@/server/storefront-auth.server";
import {
  storefrontPaymentGatewayConfig,
  verifyPaymentSignature,
} from "@/server/storefront-payment.server";

const PaymentEvent = z.object({
  event_id: z.string().trim().min(1).max(200),
  event_type: z.string().trim().min(1).max(100),
  transaction_id: z.string().trim().min(1).max(200),
  merchant_order_no: z.string().trim().min(1).max(100),
  status: z.enum(["succeeded", "failed", "cancelled"]),
  amount: z.number().positive(),
  paid_at: z.string().datetime().optional(),
  failure_code: z.string().trim().max(100).optional(),
  failure_message: z.string().trim().max(500).optional(),
});

export const Route = createFileRoute("/api/public/storefront/payments/callback/$provider")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      POST: async ({ request, params }) => {
        if (!["wechat", "alipay"].includes(params.provider)) {
          return storefrontError("Unsupported payment provider", 404);
        }
        const config = storefrontPaymentGatewayConfig();
        if (!config.webhookSecret) {
          return storefrontError("Payment webhook is not configured", 503);
        }
        const rawBody = await request.text();
        const signature = request.headers.get("x-payment-signature") ?? "";
        const signatureVerified = await verifyPaymentSignature(
          rawBody,
          signature,
          config.webhookSecret,
        );
        if (!signatureVerified) return storefrontError("Invalid payment signature", 401);

        let event: z.infer<typeof PaymentEvent>;
        try {
          event = PaymentEvent.parse(JSON.parse(rawBody));
        } catch (error) {
          return storefrontError(`Invalid payment event: ${String(error)}`, 400);
        }

        const { data: existing } = await supabaseAdmin
          .from("commerce_payment_events" as never)
          .select("id,processing_status")
          .eq("provider", params.provider)
          .eq("provider_event_id", event.event_id)
          .maybeSingle();
        if (
          existing &&
          (existing as unknown as { processing_status: string }).processing_status === "processed"
        ) {
          return storefrontJson({ ok: true, replayed: true });
        }

        const { data: payment, error: paymentError } = await supabaseAdmin
          .from("commerce_payments" as never)
          .select("id,order_id,amount,status,provider_transaction_id")
          .eq("provider", params.provider)
          .eq("provider_transaction_id", event.transaction_id)
          .maybeSingle();
        if (paymentError) return storefrontError(paymentError.message, 500);
        if (!payment) return storefrontError("Payment not found", 404);
        const paymentRow = payment as unknown as {
          id: string;
          order_id: string;
          amount: number;
          status: string;
        };

        const { data: eventRow, error: eventError } = await supabaseAdmin
          .from("commerce_payment_events" as never)
          .upsert(
            {
              payment_id: paymentRow.id,
              provider: params.provider,
              provider_event_id: event.event_id,
              event_type: event.event_type,
              signature_verified: true,
              payload: event,
              processing_status: "received",
            } as never,
            { onConflict: "provider,provider_event_id" },
          )
          .select("id")
          .single();
        if (eventError) return storefrontError(eventError.message, 500);
        const eventId = (eventRow as unknown as { id: string }).id;

        try {
          if (Math.round(Number(paymentRow.amount) * 100) !== Math.round(event.amount * 100)) {
            throw new Error("Payment amount mismatch");
          }
          if (event.status === "succeeded") {
            const paidAt = event.paid_at ?? new Date().toISOString();
            const { error: paidError } = await supabaseAdmin.rpc(
              "commerce_mark_order_paid" as never,
              {
                p_order_id: paymentRow.order_id,
                p_provider_transaction_id: event.transaction_id,
                p_paid_at: paidAt,
              } as never,
            );
            if (paidError) throw new Error(paidError.message);
            const { error: updateError } = await supabaseAdmin
              .from("commerce_payments" as never)
              .update({
                status: "succeeded",
                paid_at: paidAt,
                updated_at: new Date().toISOString(),
              } as never)
              .eq("id", paymentRow.id);
            if (updateError) throw new Error(updateError.message);
          } else {
            const { error: updateError } = await supabaseAdmin
              .from("commerce_payments" as never)
              .update({
                status: event.status,
                failure_code: event.failure_code ?? null,
                failure_message: event.failure_message ?? null,
                updated_at: new Date().toISOString(),
              } as never)
              .eq("id", paymentRow.id);
            if (updateError) throw new Error(updateError.message);
          }
          await supabaseAdmin
            .from("commerce_payment_events" as never)
            .update({
              processing_status: "processed",
              processed_at: new Date().toISOString(),
            } as never)
            .eq("id", eventId);
          return storefrontJson({ ok: true });
        } catch (error) {
          await supabaseAdmin
            .from("commerce_payment_events" as never)
            .update({
              processing_status: "failed",
              error: error instanceof Error ? error.message : String(error),
              processed_at: new Date().toISOString(),
            } as never)
            .eq("id", eventId);
          return storefrontError(
            error instanceof Error ? error.message : "Payment callback failed",
            409,
          );
        }
      },
    },
  },
});
