// Marks all notifications visible to this device as read.
// inv_handheld_notifications has no per-device read tracking yet —
// this endpoint acks the request so the APP unread badge can clear.
// When a read-state table is added, persist here.
import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok } from "@/server/handheld-auth.server";

export const Route = createFileRoute("/api/public/handheld/notifications/read-all")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        return ok({ acknowledged_at: new Date().toISOString(), device_id: auth.device.id });
      },
    },
  },
});
