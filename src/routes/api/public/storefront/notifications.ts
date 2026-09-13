import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontJson,
} from "@/server/storefront-auth.server";

type Row = {
  id: string;
  title: string;
  body: string;
  shortage_id: string | null;
  order_id: string | null;
  read_at: string | null;
  created_at: string;
};

export const Route = createFileRoute("/api/public/storefront/notifications")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const { data } = await supabaseAdmin
          .from("commerce_customer_notifications" as never)
          .select("id, title, body, shortage_id, order_id, read_at, created_at")
          .eq("customer_id", auth.customer.id)
          .order("created_at", { ascending: false })
          .limit(100);
        const items = (data as unknown as Row[] | null) ?? [];
        return storefrontJson({
          ok: true,
          data: {
            items,
            unread_count: items.filter((item) => item.read_at === null).length,
          },
        });
      },
    },
  },
});
