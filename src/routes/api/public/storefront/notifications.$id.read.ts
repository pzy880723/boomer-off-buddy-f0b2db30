import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";

export const Route = createFileRoute("/api/public/storefront/notifications/$id/read")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        // 幂等标已读：只改 read_at，不确认退款、不改售后状态
        const { data } = await supabaseAdmin
          .from("commerce_customer_notifications" as never)
          .select("id, read_at")
          .eq("id", params.id)
          .eq("customer_id", auth.customer.id)
          .maybeSingle();
        const row = data as unknown as { id: string; read_at: string | null } | null;
        if (!row) return storefrontError("Notification not found", 404, "not_found");
        if (row.read_at) return storefrontJson({ ok: true, data: { id: row.id, read_at: row.read_at } });
        const { data: updated, error } = await supabaseAdmin
          .from("commerce_customer_notifications" as never)
          .update({ read_at: new Date().toISOString() } as never)
          .eq("id", params.id)
          .eq("customer_id", auth.customer.id)
          .is("read_at", null)
          .select("id, read_at")
          .maybeSingle();
        if (error) return storefrontError(error.message, 500);
        return storefrontJson({ ok: true, data: updated ?? { id: row.id, read_at: new Date().toISOString() } });
      },
    },
  },
});
