import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  ok,
  err,
  resolveSessionUser,
  userCanAccessLocation,
} from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { LocationSwitchReq } from "@/lib/handheld/schemas";

export const Route = createFileRoute("/api/public/handheld/location/switch")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return err("Missing session token", 401, { code: "unauthorized" });

        let body: { location_id: string };
        try {
          body = LocationSwitchReq.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { detail: String(e) });
        }
        const { data: loc } = await supabaseAdmin
          .from("inv_locations")
          .select("id, name, kind, is_active")
          .eq("id", body.location_id)
          .maybeSingle();
        if (!loc) return err("Location not found", 404);
        if (!loc.is_active) return err("Location disabled", 403);

        const allowed = await userCanAccessLocation(session.user_id, loc.id);
        if (!allowed) {
          return err("You do not have permission to operate this location", 403, {
            code: "location_forbidden",
          });
        }

        await supabaseAdmin
          .from("inv_handheld_devices")
          .update({ default_location_id: loc.id, updated_at: new Date().toISOString() })
          .eq("id", auth.device.id);

        return ok({ device_id: auth.device.id, location: loc });
      },
    },
  },
});
