import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  HANDHELD_CORS,
  authenticateDevice,
  requireLocation,
  ok,
  err,
} from "@/server/handheld-auth.server";

const Body = z.object({ tote_code: z.string().trim().min(1).max(80) });

export const Route = createFileRoute("/api/public/handheld/fulfillments/$id/bind-tote")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const location = requireLocation(auth.device);
        if (!location.ok) return location.response;
        let body;
        try {
          body = Body.parse(await request.json());
        } catch (error) {
          return err(`Invalid body: ${String(error)}`, 400);
        }
        const { data, error } = await supabaseAdmin.rpc(
          "fulfillment_bind_tote" as never,
          {
            p_fulfillment_id: params.id,
            p_location_id: auth.device.location_id,
            p_tote_code: body.tote_code,
          } as never,
        );
        if (error) return err(error.message, /in use|cannot bind/i.test(error.message) ? 409 : 500);
        return ok(data);
      },
    },
  },
});
