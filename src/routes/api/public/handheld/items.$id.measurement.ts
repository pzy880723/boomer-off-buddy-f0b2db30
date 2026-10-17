import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  HANDHELD_CORS,
  authenticateDevice,
  ok,
  resolveSessionUser,
} from "@/server/handheld-auth.server";
import { errCode } from "@/lib/handheld/errors";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  loadMeasurementSku,
  saveMeasurementProduction,
} from "@/server/product-measurement-production.server";
import { loadMeasurementActor } from "@/lib/measurement.functions";
import {
  actorCanAccessLocation,
  validateMeasurementInput,
  hasAnyMeasurement,
} from "@/server/product-measurement.server";

const postBody = z
  .object({
    location_id: z.string().uuid(),
    expected_revision: z.number().int().min(0),
    client_op_id: z.string().min(8).max(128),
    measurement: z
      .object({
        height_cm: z.number().positive().max(9999.99).nullable().optional(),
        width_cm: z.number().positive().max(9999.99).nullable().optional(),
        depth_cm: z.number().positive().max(9999.99).nullable().optional(),
        diameter_cm: z.number().positive().max(9999.99).nullable().optional(),
      })
      .strict(),
  })
  .strict();

/**
 * 手持端商品实测尺寸：
 * GET  /api/public/handheld/items/{id}/measurement?location_id=... → { measurement, revision }
 * POST 同路径 body={ location_id, expected_revision, client_op_id, measurement:{...} }
 * 设备 + 员工会话 + 库位鉴权；保存走事务 RPC（版本 CAS + 幂等 + 完成活跃任务并通知）。
 */
export const Route = createFileRoute("/api/public/handheld/items/$id/measurement")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return errCode("unauthorized", "Sign in required");
        const locationId = new URL(request.url).searchParams.get("location_id");
        if (!locationId) return errCode("invalid_body", "location_id required");

        const sku = await loadMeasurementSku(params.id);
        if (!sku) return errCode("not_found", "SKU not found");
        const actor = await loadMeasurementActor(session.user_id);
        if (!actorCanAccessLocation(actor, locationId) || sku.location_id !== locationId) {
          return errCode("unauthorized_role", "No access to this location");
        }
        return ok({
          measurement: sku.measured_at
            ? {
                height_cm: sku.measurement_height_cm,
                width_cm: sku.measurement_width_cm,
                depth_cm: sku.measurement_depth_cm,
                diameter_cm: sku.measurement_diameter_cm,
                measured_at: sku.measured_at,
              }
            : null,
          revision: sku.measurement_revision,
        });
      },
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return errCode("unauthorized", "Sign in required");

        let body: z.infer<typeof postBody>;
        try {
          body = postBody.parse(await request.json());
        } catch {
          return errCode("invalid_body", "Invalid body");
        }

        const sku = await loadMeasurementSku(params.id);
        if (!sku) return errCode("not_found", "SKU not found");
        const actor = await loadMeasurementActor(session.user_id);
        if (!actorCanAccessLocation(actor, body.location_id) || sku.location_id !== body.location_id) {
          return errCode("unauthorized_role", "No access to this location");
        }

        const parsed = validateMeasurementInput(body.measurement);
        if (!parsed.ok || !hasAnyMeasurement(parsed.value)) {
          return errCode("invalid_body", "Invalid measurement");
        }

        // 活跃任务由 RPC 在 sku 行锁内查找（避免申请/保存交错漏完成任务）；
        // op 幂等回放也在锁内，重试同一 POST 返回原结果。
        try {
          const result = await saveMeasurementProduction({
            skuId: sku.id,
            taskId: null,
            actorId: session.user_id,
            clientOpId: body.client_op_id,
            expectedRevision: body.expected_revision,
            locationId: body.location_id,
            value: parsed.value,
          });
          return ok({
            revision: result.revision,
            task_id: result.task_id,
            notified: result.notified,
            replayed: result.replayed,
          });
        } catch (error) {
          const message = (error as Error).message;
          if (message === "revision_conflict") {
            return errCode("revision_conflict", "Measurement updated by someone else");
          }
          if (message === "op_conflict") {
            return errCode("op_conflict", "client_op_id reused with different content");
          }
          if (message === "location_mismatch") {
            return errCode("unauthorized_location", "SKU no longer in this location");
          }
          if (message === "not_found") return errCode("not_found", "Task not found");
          throw error;
        }
      },
    },
  },
});
