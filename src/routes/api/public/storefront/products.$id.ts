import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { STOREFRONT_CORS, storefrontError, storefrontJson } from "@/server/storefront-auth.server";
import { loadPublishedProductContent } from "@/server/product-content.server";
import { loadEngagementCounts } from "@/server/storefront-engagement.server";
import { buildMeasurementPayload } from "@/server/product-measurement.server";
import { getMeasurementAssetProduction } from "@/server/product-measurement-production.server";
import type { MeasurementAssetRow } from "@/server/product-measurement.server";
import {
  buildStorefrontProductDetail,
  STOREFRONT_DETAIL_READABLE_STATUSES,
  type StorefrontListing,
} from "@/server/storefront-products.server";

/**
 * 商品详情的实测尺寸块：无实测返回 null；素材未就绪时 diagram.status 如实为
 * pending/failed，cutout_preview_url 为 null，绝不伪造对比图。
 * ready 契约：revision/verified=true/width_cm/height_cm + 受控透明 PNG 衍生 URL
 * （/api/public/media/measurement/...，服务端校验所属商品与 ready 状态，不回原图、不丢 alpha）。
 */
async function loadStorefrontMeasurement(skuId: string) {
  const { data } = await supabaseAdmin
    .from("inv_skus")
    .select(
      "id, measurement_height_cm, measurement_width_cm, measurement_depth_cm, measurement_diameter_cm, measured_at, measurement_revision",
    )
    .eq("id", skuId)
    .maybeSingle();
  const sku = data as unknown as Parameters<typeof buildMeasurementPayload>[0] | null;
  if (!sku || !sku.measured_at) return null;
  const asset = (await getMeasurementAssetProduction(skuId, sku.measurement_revision)) as
    | (MeasurementAssetRow & { verified?: boolean; width_cm?: number | null; height_cm?: number | null })
    | null;
  const payload = buildMeasurementPayload(sku, asset);
  if (!payload) return null;
  const ready =
    payload.diagram.status === "ready" &&
    asset?.verified === true &&
    asset.width_cm != null &&
    asset.height_cm != null &&
    asset.cutout_preview_path?.startsWith("sku-listing/measurements/");
  return {
    ...payload,
    diagram: ready
      ? {
          status: "ready" as const,
          revision: sku.measurement_revision,
          verified: true,
          width_cm: asset.width_cm,
          height_cm: asset.height_cm,
          cutout_preview_url: `/api/public/media/measurement/${asset.cutout_preview_path!.slice("sku-listing/".length)}`,
          cutout_1280_url: `/api/public/media/measurement/${asset.cutout_preview_path!.slice("sku-listing/".length).replace(/-640\.png$/, "-1280.png")}`,
          bbox: payload.diagram.bbox,
          front_width_px: payload.diagram.front_width_px,
          front_height_px: payload.diagram.front_height_px,
          px_per_cm: payload.diagram.px_per_cm,
        }
      : { status: payload.diagram.status as "pending" | "failed" },
  };
}

export const Route = createFileRoute("/api/public/storefront/products/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ params }) => {
        const { data, error } = await supabaseAdmin
          .from("storefront_ready_listings" as never)
          .select(
            "id, sku_id, location_id, status, title, description, cover_url, image_urls, image_paths, price, compare_at_price, condition_grade, product_type, published_at, location:inv_locations!location_id(id,name,kind)",
          )
          .eq("id", params.id)
          // Once-published listings stay readable (sold/reserved/archived → stock 0, not purchasable);
          // draft/hidden or never-published rows are 404.
          .in("status", [...STOREFRONT_DETAIL_READABLE_STATUSES])
          .not("published_at", "is", null)
          .maybeSingle();
        if (error) return storefrontError(error.message, 500);
        if (!data) return storefrontError("Product not found", 404);
        try {
          const product = await buildStorefrontProductDetail(
            data as unknown as StorefrontListing,
          );
          if (!product) {
            return storefrontError("Product not available", 404);
          }
          const content = await loadPublishedProductContent(product.sku_id);
          const counts = (await loadEngagementCounts([product.id])).get(product.id) ?? { view_count: 0, favorite_count: 0 };
          const measurement = await loadStorefrontMeasurement(product.sku_id);
          const readiness = await supabaseAdmin
            .from("listing_readiness" as never)
            .select("content_sources, content_mode")
            .eq("sku_id", product.sku_id)
            .maybeSingle();
          // 只公开来源类型/资料ID/标题/版本，不含提示词或内部字段。
          const detail_content_sources = (
            ((readiness.data as { content_sources?: unknown } | null)?.content_sources ?? content?.auto_sources ?? []) as Array<Record<string, unknown>>
          ).flatMap((s) =>
            s.kind === "official_knowledge"
              ? [{ kind: "official_knowledge", id: String(s.id), type: String(s.type), title: String(s.title ?? ""), version: String(s.version ?? "") }]
              : s.kind === "sku_facts"
                ? [{ kind: "sku_facts" }]
                : [],
          );
          return storefrontJson({ ok: true, data: { ...product, ...counts,
            detail_content: content?.published_blocks ?? [],
            detail_content_version: content?.version ?? 0,
            detail_content_sources,
            measurement,
          } });
        } catch (metadataError) {
          return storefrontError(
            metadataError instanceof Error ? metadataError.message : "Product metadata failed",
            500,
          );
        }
      },
    },
  },
});
