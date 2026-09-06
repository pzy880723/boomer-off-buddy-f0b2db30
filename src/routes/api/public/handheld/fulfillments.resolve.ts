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
  requireStaffAtDeviceLocation,
  resolveFulfillmentByCode,
} from "@/server/handheld-fulfillment.server";

export const Route = createFileRoute("/api/public/handheld/fulfillments/resolve")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const location = requireLocation(auth.device);
        if (!location.ok) return location.response;
        const session = await resolveSessionUser(request);
        const staff = await requireStaffAtDeviceLocation(auth.device, session);
        if (!staff.ok) return staff.response;
        const code = new URL(request.url).searchParams.get("code") ?? "";
        const row = await resolveFulfillmentByCode({ raw: code, locationId: staff.locationId });
        if (!row) {
          return err("Unrecognized fulfillment code", 404, { code: "invalid_fulfillment_code" });
        }
        return ok({ fulfillment_id: row.id, code: row.code, status: row.status });
      },
    },
  },
});
