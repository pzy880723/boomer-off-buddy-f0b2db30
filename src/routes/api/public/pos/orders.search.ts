import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

export const Route = createFileRoute("/api/public/pos/orders/search")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const locationId = url.searchParams.get("location_id")?.trim();
        const query = url.searchParams.get("q")?.trim() ?? "";
        if (!locationId) return posError("location_id 必填", 400);
        const auth = await authenticatePosUser(request, locationId);
        if (!auth.ok) return auth.response;

        let orderQuery = supabaseAdmin
          .from("commerce_orders" as never)
          .select(
            "id,order_no,customer_id,payment_status,order_status,subtotal,discount_total,total_amount,paid_at,created_at,commerce_order_items(id,sku_id,title_snapshot,unit_price,quantity,line_total,epc)",
          )
          .eq("source_channel", "pos")
          .eq("sale_location_id", locationId)
          .order("created_at", { ascending: false })
          .limit(30);
        if (query) {
          const escaped = query.replace(/[%_,()]/g, " ");
          orderQuery = orderQuery.ilike("order_no", `%${escaped}%`);
        }
        const { data, error } = await orderQuery;
        if (error) return posError(error.message, 500);
        return posJson({ ok: true, data: { items: data ?? [] } });
      },
    },
  },
});
