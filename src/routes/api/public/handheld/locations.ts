import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  loadVisibleLocationsForDevice,
  ok,
  resolveSessionUser,
} from "@/server/handheld-auth.server";

export const Route = createFileRoute("/api/public/handheld/locations")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const sessionUser = await resolveSessionUser(request);
        const { locations } = await loadVisibleLocationsForDevice(
          auth.device.id,
          auth.device.location_id,
          sessionUser?.user_id,
        );
        return ok({ items: locations });
      },
    },
  },
});
