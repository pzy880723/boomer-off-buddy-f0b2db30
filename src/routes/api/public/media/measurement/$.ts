import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * 尺寸素材透明 PNG 只读代理：/api/public/media/measurement/<path>
 *
 * 只服务 sku-listing 桶 measurements/ 前缀下的 .png（保留 alpha），
 * 不接受任意外链、不允许 ..、不签名原图、不走 JPEG 衍生。
 * 路径格式：measurements/{sku_id}/{revision}.png（由 reportMeasurementDiagram 服务端校验写入）。
 */
const PATH_RE = /^measurements\/[0-9a-f-]{36}\/[0-9a-zA-Z_-]+\.png$/;

export const Route = createFileRoute("/api/public/media/measurement/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const path = decodeURIComponent(
          String((params as { _splat?: string })._splat ?? "").replace(/^\/+/, ""),
        );
        if (!PATH_RE.test(path)) return new Response("Not found", { status: 404 });

        // 所属商品验证：素材表必须存在该 sku+revision 的 ready 记录且路径一致
        const skuId = path.split("/")[1];
        const { data: asset } = await supabaseAdmin
          .from("product_measurement_assets" as never)
          .select("sku_id")
          .eq("sku_id", skuId)
          .eq("status", "ready")
          .eq("cutout_preview_path", `sku-listing/${path}`)
          .limit(1);
        if (!asset || (asset as unknown[]).length === 0) {
          return new Response("Not found", { status: 404 });
        }

        const { data, error } = await supabaseAdmin.storage.from("sku-listing").download(path);
        if (error || !data) return new Response("Not found", { status: 404 });
        const buffer = await data.arrayBuffer();
        return new Response(buffer, {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400, immutable",
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    },
  },
});
