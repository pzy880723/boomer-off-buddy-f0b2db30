import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizeCourierChoice } from "@/lib/commerce/order-policy";
import {
  STOREFRONT_CORS,
  authenticateStorefrontUser,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";

const CreateOrderBody = z.object({
  listing_ids: z.array(z.string().uuid()).min(1).max(20),
  recipient_name: z.string().trim().min(1).max(80),
  recipient_phone: z.string().trim().min(6).max(30),
  shipping_address: z.record(z.string(), z.unknown()),
  courier_service_code: z.string().trim().min(1).max(80),
  courier_service_name: z.string().trim().max(120).optional(),
  shipping_fee: z.number().min(0).max(100000).default(0),
  courier_quote_snapshot: z.record(z.string(), z.unknown()).optional(),
  customer_note: z.string().trim().max(500).optional(),
});

export const Route = createFileRoute("/api/public/storefront/orders")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateStorefrontUser(request);
        if (!auth.ok) return auth.response;
        const { data, error } = await supabaseAdmin
          .from("commerce_orders" as never)
          .select(
            "id, order_no, payment_status, order_status, total_amount, currency, courier_provider, courier_service_code, paid_at, created_at",
          )
          .eq("user_id", auth.user.id)
          .order("created_at", { ascending: false })
          .limit(100);
        if (error) return storefrontError(error.message, 500);
        return storefrontJson({ ok: true, data: data ?? [] });
      },
      POST: async ({ request }) => {
        const auth = await authenticateStorefrontUser(request);
        if (!auth.ok) return auth.response;
        const idempotencyKey = request.headers.get("idempotency-key")?.trim();
        if (!idempotencyKey) return storefrontError("Missing Idempotency-Key", 400);
        let body: z.infer<typeof CreateOrderBody>;
        try {
          body = CreateOrderBody.parse(await request.json());
        } catch (error) {
          return storefrontError(`Invalid request: ${String(error)}`, 400);
        }
        let courier;
        try {
          courier = normalizeCourierChoice(body.courier_service_code);
        } catch (error) {
          return storefrontError(error instanceof Error ? error.message : String(error), 422);
        }
        const { data, error } = await supabaseAdmin.rpc(
          "commerce_create_order" as never,
          {
            p_user_id: auth.user.id,
            p_idempotency_key: idempotencyKey,
            p_listing_ids: body.listing_ids,
            p_recipient_name: body.recipient_name,
            p_recipient_phone: body.recipient_phone,
            p_shipping_address: body.shipping_address,
            p_courier_provider: courier.provider,
            p_courier_service_code: courier.serviceCode,
            p_courier_service_name: body.courier_service_name ?? null,
            p_shipping_fee: body.shipping_fee,
            p_quote_snapshot: body.courier_quote_snapshot ?? null,
            p_customer_note: body.customer_note ?? null,
          } as never,
        );
        if (error) {
          const conflict = /not available|out of stock|duplicate/i.test(error.message);
          return storefrontError(
            error.message,
            conflict ? 409 : 500,
            conflict ? "stock_conflict" : undefined,
          );
        }
        return storefrontJson({ ok: true, data }, { status: 201 });
      },
    },
  },
});
