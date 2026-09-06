import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { authorizeFulfillment } from "@/server/handheld-fulfillment-access.server";

const Body = z.object({
  code: z.string().trim().min(1).max(200),
  client_op_id: z.string().trim().min(1).max(120),
  fulfillment_item_id: z.string().uuid().optional(),
});

export const Route = createFileRoute("/api/public/handheld/fulfillments/$id/pick-scan")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        // 按目标子单 location 授权；父订单取消/关闭一律禁止写。
        const access = await authorizeFulfillment({
          device: auth.device,
          session,
          fulfillmentId: params.id,
          mode: "write",
        });
        if (!access.ok) return access.response;
        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch (error) {
          return err(`Invalid body: ${String(error)}`, 400, { code: "validation_error" });
        }
        const { data, error } = await supabaseAdmin.rpc(
          "fulfillment_pick_scan" as never,
          {
            p_fulfillment_id: params.id,
            p_location_id: access.fulfillment.location_id,
            p_code: body.code,
            p_device_id: auth.device.id,
            p_operator_id: access.userId,
            p_client_op_id: body.client_op_id,
            p_fulfillment_item_id: body.fulfillment_item_id ?? null,
          } as never,
        );
        if (error) return err(error.message, 409);
        return ok(data);
      },
    },
  },
});
