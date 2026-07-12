import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  HANDHELD_CORS,
  authenticateDevice,
  requireLocation,
  ok,
  err,
} from "@/server/handheld-auth.server";

export const Route = createFileRoute("/api/public/handheld/fulfillments/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const location = requireLocation(auth.device);
        if (!location.ok) return location.response;
        const { data, error } = await supabaseAdmin
          .from("fulfillments" as never)
          .select(
            "*, order:commerce_orders!order_id(order_no, recipient_name, recipient_phone, shipping_address, courier_provider, courier_service_code, customer_note), location:inv_locations!location_id(id,name,kind), tote:warehouse_totes!tote_id(id,code,status), items:fulfillment_items(*, order_item:commerce_order_items!order_item_id(title_snapshot,image_snapshot,condition_snapshot,unit_price), sku:inv_skus!sku_id(sku_code,barcode,name,image_url))",
          )
          .eq("id", params.id)
          .eq("location_id", auth.device.location_id!)
          .maybeSingle();
        if (error) return err(error.message, 500);
        if (!data) return err("Fulfillment not found", 404);
        return ok(data);
      },
    },
  },
});
