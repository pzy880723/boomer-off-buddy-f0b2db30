import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  ok,
  resolveSessionUser,
} from "@/server/handheld-auth.server";
import { errCode } from "@/lib/handheld/errors";
import { listMeasurementTasksProduction } from "@/server/product-measurement-production.server";
import { loadMeasurementActor } from "@/server/measurement-actor.server";
import { actorCanAccessLocation } from "@/server/product-measurement.server";

/**
 * GET /api/public/handheld/measurements/tasks?location_id=...
 * 本店 pending+claimed 尺寸待办：task_id/sku_id/listing_id/product_name/
 * requester_count/measurement_revision。设备 + 员工会话 + 库位鉴权。
 */
export const Route = createFileRoute("/api/public/handheld/measurements/tasks")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return errCode("unauthorized", "Sign in required");
        const locationId = new URL(request.url).searchParams.get("location_id");
        if (!locationId) return errCode("invalid_body", "location_id required");

        const actor = await loadMeasurementActor(session.user_id);
        if (!actorCanAccessLocation(actor, locationId)) {
          return errCode("unauthorized_role", "No access to this location");
        }
        const items = await listMeasurementTasksProduction({ locationIds: [locationId] });
        return ok({
          items: items.map((t) => ({
            task_id: t.id,
            sku_id: t.sku_id,
            listing_id: t.listing_id,
            product_name: t.sku_name,
            status: t.status,
            claimed_by: t.claimed_by,
            requester_count: t.requester_count,
            measurement_revision: t.measurement_revision,
            created_at: t.created_at,
          })),
        });
      },
    },
  },
});
