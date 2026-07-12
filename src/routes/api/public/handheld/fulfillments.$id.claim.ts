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

export const Route = createFileRoute("/api/public/handheld/fulfillments/$id/claim")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const location = requireLocation(auth.device);
        if (!location.ok) return location.response;
        const user = await resolveSessionUser(request);
        const { data, error } = await supabaseAdmin.rpc(
          "fulfillment_claim_task" as never,
          {
            p_fulfillment_id: params.id,
            p_location_id: auth.device.location_id,
            p_device_id: auth.device.id,
            p_operator_id: user?.user_id ?? null,
          } as never,
        );
        if (error)
          return err(error.message, /another device|unavailable/i.test(error.message) ? 409 : 500);
        return ok(data);
      },
    },
  },
});
