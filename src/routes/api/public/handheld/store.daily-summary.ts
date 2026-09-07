// GET /api/public/handheld/store/daily-summary?location_id=&date=
// 今日目标 / 今日实绩 / 差额。日期为 Asia/Shanghai 自然日。
// 普通店员严格限定「设备当前绑定库位」；HQ 需显式传 location_id 并通过授权校验。
import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  userCanAccessLocation,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { loadDailySummary } from "@/server/store-targets.server";
import { shanghaiToday } from "@/lib/store-targets/sales-window";

export const Route = createFileRoute("/api/public/handheld/store/daily-summary")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        const url = new URL(request.url);
        const requested = url.searchParams.get("location_id");
        const date = url.searchParams.get("date") ?? shanghaiToday();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return err("date must be yyyy-mm-dd", 400, { code: "invalid_date" });
        }

        const session = await resolveSessionUser(request);
        let locationId = auth.device.location_id;

        if (requested && requested !== auth.device.location_id) {
          if (!session) {
            return err("Cross-location query requires a session", 401, {
              code: "session_required",
            });
          }
          const allowed = await userCanAccessLocation(session.user_id, requested);
          if (!allowed) {
            return err("You do not have permission to view this location", 403, {
              code: "location_forbidden",
            });
          }
          locationId = requested;
        } else if (session && locationId) {
          const allowed = await userCanAccessLocation(session.user_id, locationId);
          if (!allowed) {
            return err("You do not have permission to view this location", 403, {
              code: "location_forbidden",
            });
          }
        }

        if (!locationId) {
          return err("Device has no bound location", 400, { code: "location_required" });
        }

        const summary = await loadDailySummary({ locationId, date });
        return ok(summary);
      },
    },
  },
});
