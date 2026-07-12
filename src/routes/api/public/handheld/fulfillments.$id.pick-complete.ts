import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  HANDHELD_CORS,
  authenticateDevice,
  requireLocation,
  ok,
  err,
} from "@/server/handheld-auth.server";

export const Route = createFileRoute("/api/public/handheld/fulfillments/$id/pick-complete")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const location = requireLocation(auth.device);
        if (!location.ok) return location.response;
        const { data, error } = await supabaseAdmin.rpc(
          "fulfillment_complete_pick" as never,
          {
            p_fulfillment_id: params.id,
            p_location_id: auth.device.location_id,
            p_device_id: auth.device.id,
          } as never,
        );
        if (error)
          return err(error.message, /unpicked|cannot complete/i.test(error.message) ? 422 : 500);
        return ok(data);
      },
    },
  },
});
