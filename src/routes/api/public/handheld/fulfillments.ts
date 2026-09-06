import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  HANDHELD_CORS,
  authenticateDevice,
  requireLocation,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { requireStaffAtDeviceLocation } from "@/server/handheld-fulfillment.server";

const FULFILLMENT_STATUSES = new Set([
  "unallocated",
  "allocated",
  "picking",
  "picked",
  "packing",
  "packed",
  "handover_ready",
  "handed_over",
  "exception",
]);

export const Route = createFileRoute("/api/public/handheld/fulfillments")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const location = requireLocation(auth.device);
        if (!location.ok) return location.response;
        const session = await resolveSessionUser(request);
        const staff = await requireStaffAtDeviceLocation(auth.device, session);
        if (!staff.ok) return staff.response;
        const url = new URL(request.url);
        const statuses = (
          url.searchParams.get("status") ||
          "allocated,picking,picked,packing,packed,handover_ready,exception"
        )
          .split(",")
          .map((value) => value.trim())
          .filter((value) => FULFILLMENT_STATUSES.has(value));
        if (statuses.length === 0) return err("No valid fulfillment status supplied", 400);
        const { data, error } = await supabaseAdmin
          .from("fulfillments" as never)
          .select(
            "id, code, order_id, location_id, status, priority, claimed_device_id, claimed_at, created_at, order:commerce_orders!order_id(order_no, courier_provider, courier_service_code, customer_note), items:fulfillment_items(id, picked_qty, expected_qty)",
          )
          .eq("location_id", staff.locationId)
          .in("status", statuses)
          .order("priority", { ascending: false })
          .order("created_at", { ascending: true })
          .limit(100);
        if (error) return err(error.message, 500);
        const rows = data ?? [];
        // 兼容：默认仍返回数组；移动端可用 ?format=items 拿到 { items, scope }
        if (url.searchParams.get("format") === "items") {
          return ok({ items: rows, scope: `location:${staff.locationId}` });
        }
        return ok(rows);
      },
    },
  },
});
