import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

export const Route = createFileRoute("/api/public/pos/carts/held")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const locationId = url.searchParams.get("location_id")?.trim();
        if (!locationId) return posError("location_id 必填", 400);
        const auth = await authenticatePosUser(request, locationId);
        if (!auth.ok) return auth.response;
        const { data, error } = await supabaseAdmin
          .from("pos_held_carts" as never)
          .select(
            "id,shift_id,customer_id,note,discount_snapshot,benefit_snapshot,status,held_at,pos_held_cart_items(id,sku_id,quantity,price_snapshot,ownership_snapshot,discount_eligible)",
          )
          .eq("location_id", locationId)
          .eq("status", "held")
          .order("held_at", { ascending: false })
          .limit(50);
        if (error) return posError(error.message, 500);
        return posJson({ ok: true, data: { items: data ?? [] } });
      },
    },
  },
});
