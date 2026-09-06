import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  HANDHELD_CORS,
  authenticateDevice,
  requireLocation,
  resolveSessionUser,
  userCanAccessLocation,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { requireStaffAtDeviceLocation } from "@/server/handheld-fulfillment.server";
import { isHqUser } from "@/server/handheld-orders.server";

export const Route = createFileRoute("/api/public/handheld/fulfillments/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const location = requireLocation(auth.device);
        if (!location.ok) return location.response;
        const session = await resolveSessionUser(request);
        const staff = await requireStaffAtDeviceLocation(auth.device, session);
        if (!staff.ok) return staff.response;

        const hq = await isHqUser(staff.userId);
        let query = supabaseAdmin
          .from("fulfillments" as never)
          .select(
            "*, order:commerce_orders!order_id(order_no, recipient_name, recipient_phone, shipping_address, courier_provider, courier_service_code, customer_note), location:inv_locations!location_id(id,name,kind), tote:warehouse_totes!tote_id(id,code,status), items:fulfillment_items(*, order_item:commerce_order_items!order_item_id(title_snapshot,image_snapshot,condition_snapshot,unit_price), sku:inv_skus!sku_id(sku_code,barcode,name,image_url))",
          )
          .eq("id", params.id);
        // 普通员工严格限制在设备当前库位；HQ 可跨店，但仍需对该库位有授权。
        if (!hq) query = query.eq("location_id", staff.locationId);
        const { data, error } = await query.maybeSingle();
        if (error) return err(error.message, 500);
        if (!data) return err("Fulfillment not found", 404);
        if (hq) {
          const rowLocation = (data as { location_id: string }).location_id;
          if (
            rowLocation !== staff.locationId &&
            !(await userCanAccessLocation(staff.userId, rowLocation))
          ) {
            return err("You do not have permission to operate this location", 403, {
              code: "location_forbidden",
            });
          }
        }
        return ok(data);
      },
    },
  },
});
