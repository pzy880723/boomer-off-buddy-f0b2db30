import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontJson,
} from "@/server/storefront-auth.server";

export const Route = createFileRoute("/api/public/storefront/shortages")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const { data: orders } = await supabaseAdmin
          .from("commerce_orders" as never)
          .select("id, order_no")
          .eq("customer_id", auth.customer.id)
          .limit(200);
        const orderRows = (orders as { id: string; order_no: string }[] | null) ?? [];
        if (orderRows.length === 0) return storefrontJson({ ok: true, data: { items: [] } });
        const { data } = await supabaseAdmin
          .from("fulfillment_shortages" as never)
          .select("id, order_id, quantity, reason, status, refund_state, created_at")
          .in(
            "order_id",
            orderRows.map((row) => row.id),
          )
          .order("created_at", { ascending: false })
          .limit(100);
        const byOrder = new Map(orderRows.map((row) => [row.id, row.order_no]));
        const items = (
          (data as
            | {
                id: string;
                order_id: string;
                quantity: number;
                reason: string | null;
                status: string;
                refund_state: string;
                created_at: string;
              }[]
            | null) ?? []
        ).map((row) => ({ ...row, order_no: byOrder.get(row.order_id) ?? null }));
        return storefrontJson({ ok: true, data: { items } });
      },
    },
  },
});
