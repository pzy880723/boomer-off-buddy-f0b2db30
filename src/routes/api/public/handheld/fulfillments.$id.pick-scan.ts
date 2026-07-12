import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  HANDHELD_CORS,
  authenticateDevice,
  requireLocation,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";

const Body = z.object({
  code: z.string().trim().min(1).max(200),
  client_op_id: z.string().trim().min(1).max(120),
});

export const Route = createFileRoute("/api/public/handheld/fulfillments/$id/pick-scan")({
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
        const user = await resolveSessionUser(request);
        const { data, error } = await supabaseAdmin.rpc(
          "fulfillment_pick_scan" as never,
          {
            p_fulfillment_id: params.id,
            p_location_id: auth.device.location_id,
            p_code: body.code,
            p_device_id: auth.device.id,
            p_operator_id: user?.user_id ?? null,
            p_client_op_id: body.client_op_id,
          } as never,
        );
        if (error) return err(error.message, 409);
        return ok(data);
      },
    },
  },
});
