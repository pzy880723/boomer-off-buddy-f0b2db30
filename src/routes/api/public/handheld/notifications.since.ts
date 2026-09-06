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
  resolveNotificationScope,
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

        const scope = await resolveNotificationScope({
          userId: session.user_id,
          deviceId: auth.device.id,
          deviceLocationId: auth.device.location_id,
        });
        try {
          const page = await listNotificationsSince({ scope, since: q.ts, limit: q.limit });
          return ok({ ...page, scope: describeScope(scope) });
        } catch (error) {
          return err(error instanceof Error ? error.message : String(error), 500);
        }
      },
    },
  },
});
