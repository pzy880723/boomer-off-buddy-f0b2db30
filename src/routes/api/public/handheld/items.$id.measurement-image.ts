import { createFileRoute } from "@tanstack/react-router";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  HANDHELD_CORS,
  authenticateDevice,
  ok,
  resolveSessionUser,
} from "@/server/handheld-auth.server";
import { errCode } from "@/lib/handheld/errors";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadMeasurementSku } from "@/server/product-measurement-production.server";
import { loadMeasurementActor } from "@/lib/measurement.functions";
import { actorCanAccessLocation } from "@/server/product-measurement.server";
import {
  MEASUREMENT_IMAGE_MAX_BYTES,
  deriveMeasurementPngs,
  validateMeasurementImage,
} from "@/server/measurement-image.server";

const postBody = z
  .object({
    location_id: z.string().uuid(),
    revision: z.number().int().min(1),
    client_op_id: z.string().min(8).max(128),
    image_png_base64: z.string().min(16),
    verified_front: z.literal(true),
  })
  .strict();

/**
 * POST /api/public/handheld/items/{id}/measurement-image
 * 上传商品尺寸素材透明 PNG（客户端 U2NET 抠图 + 人工确认正视图）。
 * 服务端重新校验：PNG ≤5MB ≤2000px、真实 alpha、trim bbox 高宽比与实测比误差 ≤3%、
 * 实测 height/width(缺省用 diameter) 齐全、revision CAS、当前库位鉴权。
 * 通过才生成 640/1280 受控衍生（contenthash 命名，重复同内容幂等），存独立
 * measurements/ 前缀，不改原主图。文字尺寸保存不依赖本接口。
 */
export const Route = createFileRoute("/api/public/handheld/items/$id/measurement-image")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
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

        const png = Buffer.from(body.image_png_base64, "base64");
        if (png.length > MEASUREMENT_IMAGE_MAX_BYTES) {
          return errCode("invalid_body", "Image too large (max 5MB)");
        }

        const sku = await loadMeasurementSku(params.id);
        if (!sku) return errCode("not_found", "SKU not found");
        const actor = await loadMeasurementActor(session.user_id);
        if (!actorCanAccessLocation(actor, body.location_id) || sku.location_id !== body.location_id) {
          return errCode("unauthorized_role", "No access to this location");
        }
        // 版本 CAS：几何必须绑定当前实测版本，旧版本不可 ready
        if (sku.measurement_revision !== body.revision || !sku.measured_at) {
          return errCode("revision_conflict", "Measurement revision mismatch, re-measure first");
        }

        const validated = await validateMeasurementImage(png, {
          height_cm: sku.measurement_height_cm,
          width_cm: sku.measurement_width_cm,
          diameter_cm: sku.measurement_diameter_cm,
        });
        if (!validated.ok) {
          const messages: Record<string, string> = {
            not_png: "Image must be PNG",
            too_large: "Image too large (max 5MB)",
            too_big_dimensions: "Image exceeds 2000px",
            no_alpha: "Image must have real transparent background",
            empty_foreground: "No foreground detected",
            ratio_mismatch: "Image aspect ratio does not match measured size, retake photo",
            missing_measurement: "Measured height and width required before upload",
          };
          return errCode("validation_error", messages[validated.error]);
        }

        const v = validated.value;
        const hash = createHash("sha256").update(v.trimmedPng).digest("hex").slice(0, 16);
        const base = `measurements/${sku.id}/${body.revision}-${hash}`;
        const path640 = `${base}-640.png`;
        const path1280 = `${base}-1280.png`;

        const { png640, png1280 } = await deriveMeasurementPngs(v.trimmedPng);
        for (const [path, buf] of [
          [path640, png640],
          [path1280, png1280],
        ] as const) {
          const { error } = await supabaseAdmin.storage
            .from("sku-listing")
            .upload(path, buf, { contentType: "image/png", upsert: true });
          if (error) return errCode("internal_error", `Upload failed: ${error.message}`);
        }

        // 素材落库：CAS（仅当前 revision）+ 受控路径 + 完整几何；同内容重复上传幂等
        const widthCm = sku.measurement_width_cm ?? sku.measurement_diameter_cm;
        const { data: existing } = await supabaseAdmin
          .from("product_measurement_assets" as never)
          .select("sku_id, revision")
          .eq("sku_id", sku.id)
          .eq("revision", body.revision)
          .maybeSingle();
        const row = {
          sku_id: sku.id,
          revision: body.revision,
          status: "ready",
          cutout_preview_path: `sku-listing/${path640}`,
          bbox: v.bbox,
          front_width_px: v.frontWidthPx,
          front_height_px: v.frontHeightPx,
          px_per_cm: v.pxPerCm,
          error: null,
          verified: true,
          width_cm: widthCm,
          height_cm: sku.measurement_height_cm,
          updated_at: new Date().toISOString(),
        };
        const { error: assetError } = existing
          ? await supabaseAdmin
              .from("product_measurement_assets" as never)
              .update(row as never)
              .eq("sku_id", sku.id)
              .eq("revision", body.revision)
          : await supabaseAdmin.from("product_measurement_assets" as never).insert(row as never);
        if (assetError) return errCode("internal_error", assetError.message);

        return ok({
          diagram: {
            status: "ready",
            revision: body.revision,
            verified: true,
            width_cm: widthCm,
            height_cm: sku.measurement_height_cm,
            cutout_preview_url: `/api/public/media/measurement/${path640}`,
            cutout_1280_url: `/api/public/media/measurement/${path1280}`,
            bbox: v.bbox,
            front_width_px: v.frontWidthPx,
            front_height_px: v.frontHeightPx,
            px_per_cm: v.pxPerCm,
          },
        });
      },
    },
  },
});
