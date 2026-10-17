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
import { loadMeasurementActor } from "@/server/measurement-actor.server";
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

        // 权限/当前门店/正库存在 measurement_claim RPC 锁内校验；错误不含门店信息
        try {
          const result = await claimTaskProduction(params.id, session.user_id);
          return ok({ task_id: result.task_id, status: "claimed", replayed: result.replayed });
        } catch (error) {
          const message = (error as Error).message;
          if (message === "already_claimed") return errCode("already_exists", "Task claimed by someone else");
          if (message === "not_found") return errCode("not_found", "Task not found");
          if (message === "forbidden" || message === "no_stock") {
            return errCode("unauthorized_role", "No access to this task");
          }
          return errCode("internal", "Claim failed");
        }
      },
    },
  },
});
