import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { buildFulfillmentTicket } from "@/server/handheld-fulfillment.server";
import { authorizeFulfillment } from "@/server/handheld-fulfillment-access.server";

export const Route = createFileRoute("/api/public/handheld/fulfillments/$id/ticket")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        // 出票按目标子单 location 授权（HQ 不依赖设备绑定库位），订单取消/关闭禁止出票。
        const access = await authorizeFulfillment({
          device: auth.device,
          session,
          fulfillmentId: params.id,
          mode: "write",
        });
        if (!access.ok) return access.response;
        const result = await buildFulfillmentTicket({
          fulfillmentId: params.id,
          locationId: access.fulfillment.location_id,
        });
        if (!result.ok) {
          return err(result.code, result.code === "order_unpaid" ? 409 : 404, {
            code: result.code,
          });
        }
        return ok({ ...result.ticket, scope: access.scope });
      },
    },
  },
});
