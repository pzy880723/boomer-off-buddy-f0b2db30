import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";
import { withOrderItemThumbnails } from "@/server/storefront-order-detail-media.server";
import { resolveStorefrontOrderId } from "@/server/storefront-orders.server";

export const Route = createFileRoute("/api/public/storefront/orders/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;

        let orderId: string | null;
        try {
          orderId = await resolveStorefrontOrderId(params.id, auth.customer.id, {
            async findByOrderNo(orderNo, customerId) {
              const { data, error } = await supabaseAdmin
                .from("commerce_orders" as never)
                .select("id")
                .eq("order_no", orderNo)
                .eq("customer_id", customerId)
                .maybeSingle();
              if (error) throw new Error(error.message);
              return (data as { id?: string } | null)?.id ?? null;
            },
            async findByMerchantOrderNo(merchantOrderNo, customerId) {
              const { data, error } = await supabaseAdmin
                .from("commerce_payments" as never)
                .select("order:commerce_orders!inner(id,customer_id)")
                .eq("merchant_order_no", merchantOrderNo)
                .eq("order.customer_id", customerId)
                .maybeSingle();
              if (error) throw new Error(error.message);
              const order = (data as { order?: { id?: string; customer_id?: string } } | null)?.order;
              return order?.customer_id === customerId ? (order.id ?? null) : null;
            },
          });
        } catch (error) {
          return storefrontError(error instanceof Error ? error.message : "Order lookup failed", 500);
        }
        if (!orderId) return storefrontError("Order not found", 404);

        const { data, error } = await supabaseAdmin
          .from("commerce_orders" as never)
          .select(
            "*, items:commerce_order_items(*), fulfillments(*, shipment:shipments(*, events:shipment_events(*)))",
          )
          .eq("id", orderId)
          .eq("customer_id", auth.customer.id)
          .maybeSingle();
        if (error) return storefrontError(error.message, 500);
        if (!data) return storefrontError("Order not found", 404);
        // 展示图一律压缩衍生图；无法安全转换为 null（不回退原图）。归属过滤保持不变。
        return storefrontJson({ ok: true, data: await withOrderItemThumbnails(data) });
      },
    },
  },
});
