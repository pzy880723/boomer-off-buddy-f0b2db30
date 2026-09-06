import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import {
  countUnread,
  markAllNotificationsRead,
  resolveNotificationScope,
} from "@/server/handheld-notifications.server";

export const Route = createFileRoute("/api/public/handheld/notifications/read-all")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return err("Employee session required", 401, { code: "session_required" });
        const scope = await resolveNotificationScope({
          userId: session.user_id,
          deviceId: auth.device.id,
          deviceLocationId: auth.device.location_id,
        });
        try {
          const result = await markAllNotificationsRead(scope);
          return ok({ ...result, unread_count: await countUnread(scope) });
        } catch (error) {
          return err(error instanceof Error ? error.message : String(error), 500);
        }
      },
    },
  },
});
