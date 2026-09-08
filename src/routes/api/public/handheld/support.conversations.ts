import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import {
  listStaffConversations,
  resolveSupportAccess,
  resolveConversationLocationFilter,
} from "@/server/support.server";

export const Route = createFileRoute("/api/public/handheld/support/conversations")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return err("Employee session required", 401, { code: "session_required" });
        const url = new URL(request.url);
        const access = await resolveSupportAccess(session.user_id);
        const filter = resolveConversationLocationFilter(
          access,
          url.searchParams.get("location_id"),
        );
        if (!filter.ok) {
          return err("Location not authorized for this account", 403, { code: filter.code });
        }
        try {
          const page = await listStaffConversations({
            access,
            status: url.searchParams.get("status"),
            limit: Number(url.searchParams.get("limit") ?? 30),
            cursor: url.searchParams.get("cursor"),
            location_id: filter.location_id,
          });
          return ok({
            items: page.items,
            next_cursor: page.next_cursor,
            location_id: filter.location_id,
            scope: access.is_hq_agent
              ? filter.location_id
                ? "hq_single_location"
                : "hq_all_conversations"
              : "assigned_locations",
          });
        } catch (error) {
          return err(error instanceof Error ? error.message : String(error), 500);
        }
      },
    },
  },
});
