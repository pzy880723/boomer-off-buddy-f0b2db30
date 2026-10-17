import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  ok,
  resolveSessionUser,
} from "@/server/handheld-auth.server";
import { errCode } from "@/lib/handheld/errors";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { claimTaskProduction } from "@/server/product-measurement-production.server";
import { loadMeasurementActor } from "@/lib/measurement.functions";
import { actorCanAccessLocation } from "@/server/product-measurement.server";

/** POST /api/public/handheld/measurements/tasks/{id}/claim — 领取尺寸待办 */
export const Route = createFileRoute("/api/public/handheld/measurements/tasks/$id/claim")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return errCode("unauthorized", "Sign in required");

        const { data: task } = await supabaseAdmin
          .from("product_measurement_tasks" as never)
          .select("id, location_id, status")
          .eq("id", params.id)
          .maybeSingle();
        const row = task as unknown as { id: string; location_id: string | null; status: string } | null;
        if (!row || row.status === "completed" || row.status === "cancelled") {
          return errCode("not_found", "Task not found");
        }
        const actor = await loadMeasurementActor(session.user_id);
        if (!actorCanAccessLocation(actor, row.location_id)) {
          return errCode("unauthorized_role", "No access to this location");
        }
        try {
          await claimTaskProduction(params.id, session.user_id);
        } catch (error) {
          const message = (error as Error).message;
          if (message === "already_claimed") return errCode("already_exists", "Task claimed by someone else");
          if (message === "not_found") return errCode("not_found", "Task not found");
          throw error;
        }
        return ok({ task_id: params.id, status: "claimed" });
      },
    },
  },
});
