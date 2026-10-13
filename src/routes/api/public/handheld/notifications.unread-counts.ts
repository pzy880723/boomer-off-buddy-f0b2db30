import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import {
  resolveNotificationScope,
  applyRequestedLocation,
  effectiveLocationIds,
} from "@/server/handheld-notifications.server";

/**
 * GET /api/public/handheld/notifications/unread-counts?location_id=<当前库位>
 * 设备 token + 员工 session；location_id 必须在账号授权门店内（否则 403）。
 * data: {customers,internal,orders,system,total}，数据库全量计数（handheld_unread_counts）。
 * 不传 location_id：账号全部授权门店；总部账号另含无门店的通用咨询。
 */
export const Route = createFileRoute("/api/public/handheld/notifications/unread-counts")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return err("Employee session required", 401, { code: "session_required" });
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
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin.rpc("handheld_unread_counts", {
          p_user_id: scope.user_id,
          p_device_id: scope.device_id,
          p_location_ids: effectiveLocationIds(scope),
          p_include_unlocated: scope.is_hq && !scope.filter_location_id,
        });
        if (error) return err(`unread_counts_failed: ${error.message}`, 500);
        const d = (data ?? {}) as Record<string, number>;
        const n = (k: string) => Math.max(0, Number(d[k] ?? 0) | 0);
        const counts = { customers: n("customers"), internal: n("internal"), orders: n("orders"), system: n("system") };
        return ok({ ...counts, total: counts.customers + counts.internal + counts.orders + counts.system });
      },
    },
  },
});
