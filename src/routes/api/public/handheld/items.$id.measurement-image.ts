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
import {
  loadMeasurementSku,
  loadSkuStockRows,
  registerMeasurementAssetProduction,
  replayAssetProduction,
  uploadMeasurementDerivativeProduction,
} from "@/server/product-measurement-production.server";
import { loadMeasurementActor } from "@/server/measurement-actor.server";
import { measurementLocationAccess } from "@/server/product-measurement.server";
import {
  MEASUREMENT_REQUEST_MAX_BYTES,
  MEASUREMENT_BASE64_MAX_LEN,
  decodeStrictBase64,
  deriveMeasurementPngs,
  checkMeasurementRatio,
  extractMeasurementForeground,
  readJsonBodyLimited,
} from "@/server/measurement-image.server";

const postBody = z
  .object({
    location_id: z.string().uuid(),
    revision: z.number().int().min(1),
    client_op_id: z.string().min(8).max(128),
    image_png_base64: z.string().min(16).max(MEASUREMENT_BASE64_MAX_LEN),
    verified_front: z.literal(true),
  })
  .strict();

const IMAGE_ERRORS: Record<string, string> = {
  not_png: "Image must be PNG",
  too_large: "Image too large (max 5MB)",
  too_big_dimensions: "Image exceeds 2000px",
  no_alpha: "Image must have real transparent background",
  empty_foreground: "No foreground detected",
  ratio_mismatch: "Image aspect ratio does not match measured size, retake photo",
  missing_measurement: "Measured height and width required before upload",
};

/**
 * POST /api/public/handheld/items/{id}/measurement-image
 * 上传商品尺寸素材透明 PNG（客户端 U2NET 抠图 + 人工确认正视图）。
 * 请求体总上限 7MB（流式计数），base64 严格校验，PNG ≤5MB ≤2000px；
 * 服务端重新校验真实 alpha、trim bbox 高宽比与实测比误差 ≤3%。
 * 通过才生成 640/1280 受控衍生（contenthash 命名），存独立 measurements/ 前缀，不改原主图。
 * ready 只由 measurement_asset_register RPC 在 sku 行锁内登记（复核当前 location/revision/
 * 实测宽高/actor 权限 + op 指纹）；HTTP 成功只基于登记返回结果。错误只回受控 code。
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

        const raw = await readJsonBodyLimited(request, MEASUREMENT_REQUEST_MAX_BYTES);
        if (!raw.ok) {
          return raw.error === "too_large"
            ? errCode("payload_too_large", "Request body exceeds 7MB")
            : errCode("invalid_body", "Invalid body");
        }
        const parsed = postBody.safeParse(raw.value);
        if (!parsed.success) return errCode("invalid_body", "Invalid body");
        const body = parsed.data;

        const png = decodeStrictBase64(body.image_png_base64);
        if (!png) return errCode("invalid_body", "image_png_base64 must be strict base64");

        let sku;
        try {
          sku = await loadMeasurementSku(params.id);
        } catch (error) {
          console.error("[measurement-image] load", (error as Error).message);
          return errCode("internal_error", "Temporarily unavailable");
        }
        if (!sku) return errCode("not_found", "SKU not found");

        // 与实测无关的前景提取（确定性），先算 contenthash 以便识别已成功的原请求
        const fg = await extractMeasurementForeground(png);
        if (!fg.ok) return errCode("validation_error", IMAGE_ERRORS[fg.error], { reason: fg.error });
        const hash = createHash("sha256").update(fg.value.trimmedPng).digest("hex").slice(0, 16);

        // 已成功 op 回放：只匹配当前 actor + 原 client_op_id + 完全一致指纹（sku/revision/location/contenthash）；
        // 命中直接返回原结果，不上传、不登记、不改版本；未命中继续下方全部当前校验
        try {
          const replay = await replayAssetProduction({
            skuId: sku.id,
            actorId: session.user_id,
            clientOpId: body.client_op_id,
            locationId: body.location_id,
            revision: body.revision,
            contentHash: hash,
          });
          if (replay) {
            const p640 = replay.cutout_preview_path.replace(/^sku-listing\//, "");
            return ok({
              replayed: true,
              diagram: {
                status: "ready",
                revision: replay.revision,
                verified: true,
                width_cm: replay.width_cm,
                height_cm: replay.height_cm,
                cutout_preview_url: `/api/public/media/measurement/${p640}`,
                cutout_1280_url: `/api/public/media/measurement/${p640.replace(/-640\.png$/, "-1280.png")}`,
                bbox: replay.bbox,
                front_width_px: replay.front_width_px,
                front_height_px: replay.front_height_px,
                px_per_cm: replay.px_per_cm,
              },
            });
          }
        } catch (error) {
          if ((error as Error).message === "op_conflict") {
            return errCode("op_conflict", "client_op_id reused with a different image");
          }
          return errCode("internal_error", "Temporarily unavailable");
        }

        let actor;
        try {
          actor = await loadMeasurementActor(session.user_id);
        } catch (error) {
          console.error("[measurement-image] actor", (error as Error).message);
          return errCode("internal_error", "Temporarily unavailable");
        }
        // 门店归属以 inv_stocks 为准：只有该店确有正库存才能上传（HQ 也不例外）；登记 RPC 锁内重读
        let access;
        try {
          access = measurementLocationAccess(actor, await loadSkuStockRows(sku.id), body.location_id);
        } catch (error) {
          console.error("[measurement-image] stock", (error as Error).message);
          return errCode("internal_error", "Temporarily unavailable");
        }
        if (access === "none") return errCode("unauthorized_role", "No access to this location");
        // 沿用既有契约：无实物与跨店同为 403 unauthorized_role（原生端已处理）
        if (access !== "edit") return errCode("unauthorized_role", "SKU has no stock in this location");
        // 预检（快速失败）；最终以登记 RPC 锁内复核为准
        if (sku.measurement_revision !== body.revision || !sku.measured_at) {
          return errCode("revision_conflict", "Measurement revision mismatch, re-measure first");
        }

        const validated = checkMeasurementRatio(fg.value, {
          height_cm: sku.measurement_height_cm,
          width_cm: sku.measurement_width_cm,
          diameter_cm: sku.measurement_diameter_cm,
        });
        if (!validated.ok) {
          return errCode("validation_error", IMAGE_ERRORS[validated.error], { reason: validated.error });
        }

        const v = validated.value;
        const heightCm = Number(sku.measurement_height_cm);
        const widthCm = Number(sku.measurement_width_cm ?? sku.measurement_diameter_cm);
        const base = `measurements/${sku.id}/${body.revision}-${hash}`;
        const path640 = `${base}-640.png`;
        const path1280 = `${base}-1280.png`;

        try {
          const { png640, png1280 } = await deriveMeasurementPngs(v.trimmedPng);
          await uploadMeasurementDerivativeProduction(path640, png640);
          await uploadMeasurementDerivativeProduction(path1280, png1280);
        } catch {
          return errCode("internal_error", "Image storage failed, retry with same client_op_id");
        }

        let registered;
        try {
          registered = await registerMeasurementAssetProduction({
            skuId: sku.id,
            actorId: session.user_id,
            clientOpId: body.client_op_id,
            locationId: body.location_id,
            revision: body.revision,
            heightCm,
            widthCm,
            contentHash: hash,
            previewPath: `sku-listing/${path640}`,
            bbox: v.bbox,
            frontWidthPx: v.frontWidthPx,
            frontHeightPx: v.frontHeightPx,
            pxPerCm: v.pxPerCm,
          });
        } catch (error) {
          const code = (error as Error).message;
          switch (code) {
            case "revision_conflict":
              return errCode("revision_conflict", "Measurement changed during upload, re-measure and retake");
            case "location_mismatch":
            case "unauthorized_role":
              return errCode("unauthorized_role", "No access to this location");
            case "op_conflict":
              return errCode("op_conflict", "client_op_id reused with a different image");
            case "image_conflict":
              return errCode("image_conflict", "Another image is already registered for this revision; re-measure to replace");
            case "not_found":
              return errCode("not_found", "SKU not found");
            default:
              return errCode("internal_error", "Image registration failed, retry with same client_op_id");
          }
        }

        return ok({
          replayed: registered.replayed,
          diagram: {
            status: "ready",
            revision: registered.revision,
            verified: true,
            width_cm: registered.width_cm,
            height_cm: registered.height_cm,
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
