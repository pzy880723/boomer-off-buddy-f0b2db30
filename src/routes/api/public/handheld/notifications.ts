import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import {
  describeScope,
  listNotifications,
  resolveNotificationScope,
  applyRequestedLocation,
} from "@/server/handheld-notifications.server";

export const Route = createFileRoute("/api/public/handheld/notifications")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return err("Employee session required", 401, { code: "session_required" });

        const url = new URL(request.url);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 100);
        const cursor = url.searchParams.get("cursor");
        const unreadOnly = url.searchParams.get("unread_only") === "true";
        const baseScope = await resolveNotificationScope({
          userId: session.user_id,
          deviceId: auth.device.id,
          deviceLocationId: auth.device.location_id,
        });
        const scoped = applyRequestedLocation(baseScope, new URL(request.url).searchParams.get("location_id"));
        if (!scoped.ok) {
          return scoped.code === "validation_error"
            ? err("Invalid location_id", 400, { code: "validation_error" })
            : err("Location not authorized for this account", 403, { code: "location_forbidden" });
        }
        const scope = scoped.scope;
        try {
          const page = await listNotifications({ scope, limit, cursor, unreadOnly });
          return ok({
            items: page.items,
            next_cursor: page.next_cursor,
            next_page_cursor: page.next_page_cursor,
            scope: describeScope(scope),
          });
        } catch (error) {
          return err(error instanceof Error ? error.message : String(error), 500);
        }
      },
    },
  },
});
