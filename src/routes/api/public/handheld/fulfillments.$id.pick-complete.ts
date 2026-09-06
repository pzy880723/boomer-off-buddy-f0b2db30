import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import {
  authorizeFulfillment,
  loadPickGuard,
} from "@/server/handheld-fulfillment-access.server";

export const Route = createFileRoute("/api/public/handheld/fulfillments/$id/pick-complete")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        const access = await authorizeFulfillment({
          device: auth.device,
          session,
          fulfillmentId: params.id,
          mode: "write",
        });
        if (!access.ok) return access.response;

        // 服务端真实判定：pending_customer 缺货、refund_pending 退款、未拣完一律阻止。
        const { guard } = await loadPickGuard(access.fulfillment);
        if (!guard.can_complete_pick) {
          return err("Pick cannot be completed yet", 409, {
            code: "pick_blocked",
            blocked_reasons: guard.blocked_reasons,
            can_complete_pick: false,
          });
        }

        const { data, error } = await supabaseAdmin.rpc(
          "fulfillment_complete_pick" as never,
          {
            p_fulfillment_id: params.id,
            p_location_id: access.fulfillment.location_id,
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
