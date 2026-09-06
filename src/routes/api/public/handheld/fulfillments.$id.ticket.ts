import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  requireLocation,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import {
  buildFulfillmentTicket,
  requireStaffAtDeviceLocation,
} from "@/server/handheld-fulfillment.server";

export const Route = createFileRoute("/api/public/handheld/fulfillments/$id/ticket")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const location = requireLocation(auth.device);
        if (!location.ok) return location.response;
        const session = await resolveSessionUser(request);
        const staff = await requireStaffAtDeviceLocation(auth.device, session);
        if (!staff.ok) return staff.response;
        const result = await buildFulfillmentTicket({
          fulfillmentId: params.id,
          locationId: staff.locationId,
        });
        if (!result.ok) {
          return err(result.code, result.code === "order_unpaid" ? 409 : 404, {
            code: result.code,
          });
        }
        return ok(result.ticket);
      },
    },
  },
});
