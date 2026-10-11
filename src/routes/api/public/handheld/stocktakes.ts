import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, resolveSessionUser, ok, err } from "@/server/handheld-auth.server";
import { requireStaffAtDeviceLocation } from "@/server/handheld-fulfillment.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/handheld/stocktakes")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const staff = await requireStaffAtDeviceLocation(auth.device, await resolveSessionUser(request));
        if (!staff.ok) return staff.response;
        const url = new URL(request.url);
        const requested = url.searchParams.get("location_id");
        if (requested && requested !== staff.locationId)
          return err("Location not authorized for this device", 403, { code: "location_forbidden" });
        const locationId = staff.locationId;
        const status = url.searchParams.get("status");

        let qb = supabaseAdmin
          .from("stocktakes")
          .select("id, code, status, opened_at, submitted_at, reviewed_at, notes")
          .eq("location_id", locationId)
          .order("opened_at", { ascending: false })
          .limit(50);
        if (status) qb = qb.eq("status", status);

        const { data, error } = await qb;
        if (error) return err(error.message, 500);
        return ok({ items: data ?? [] });
      },
    },
  },
});
