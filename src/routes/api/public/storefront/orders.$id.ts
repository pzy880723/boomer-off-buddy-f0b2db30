import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  STOREFRONT_CORS,
  authenticateStorefrontUser,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";

export const Route = createFileRoute("/api/public/storefront/orders/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateStorefrontUser(request);
        if (!auth.ok) return auth.response;
        const { data, error } = await supabaseAdmin
          .from("commerce_orders" as never)
          .select(
            "*, items:commerce_order_items(*), fulfillments(*, shipment:shipments(*, events:shipment_events(*)))",
          )
          .eq("id", params.id)
          .eq("user_id", auth.user.id)
          .maybeSingle();
        if (error) return storefrontError(error.message, 500);
        if (!data) return storefrontError("Order not found", 404);
        return storefrontJson({ ok: true, data });
      },
    },
  },
});
