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
  listNotificationsSince,
  listNotificationChanges,
  parseChangeCursor,
  resolveNotificationScope,
  applyRequestedLocation,
} from "@/server/handheld-notifications.server";
import { NotificationsSinceQuery } from "@/lib/handheld/schemas";

export const Route = createFileRoute("/api/public/handheld/notifications/since")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return err("Employee session required", 401, { code: "session_required" });

        const url = new URL(request.url);
        let q: ReturnType<typeof NotificationsSinceQuery.parse>;
        try {
          q = NotificationsSinceQuery.parse({
            ts: url.searchParams.get("ts") ?? undefined,
            limit: url.searchParams.get("limit") ?? undefined,
          });
        } catch (e) {
          return err("Invalid query", 400, { code: "validation_error", detail: String(e) });
        }

        const rawCursor = url.searchParams.get("cursor");
        const changeCursor = rawCursor ? parseChangeCursor(rawCursor) : null;
        if (rawCursor && !changeCursor) {
          return err("Invalid cursor", 400, { code: "validation_error" });
        }
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
          if (changeCursor) {
            const page = await listNotificationChanges({ scope, cursor: changeCursor, limit: q.limit });
            return ok({ ...page, scope: describeScope(scope) });
          }
          const page = await listNotificationsSince({ scope, since: q.ts, limit: q.limit });
          return ok({ ...page, scope: describeScope(scope) });
        } catch (error) {
          return err(error instanceof Error ? error.message : String(error), 500);
        }
      },
    },
  },
});
