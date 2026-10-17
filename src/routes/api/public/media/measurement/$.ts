import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * 尺寸素材透明 PNG 只读代理：/api/public/media/measurement/<path>
 *
 * 只服务 sku-listing 桶 measurements/ 前缀下受控衍生（{revision}-{hash}-640.png / -1280.png），
 * 且必须同时满足：素材表存在该 sku+revision 的 verified ready 记录、revision 等于商品当前
 * 实测版本、商品对应 listing 处于公开可读状态。不满足一律 404——
 * 不服务原图、不接受任意外链、不读他品/旧版本/未上架私有素材。
 */
const PATH_RE = /^measurements\/([0-9a-f-]{36})\/(\d+)-[0-9a-f]{16}-(640|1280)\.png$/;

export const Route = createFileRoute("/api/public/media/measurement/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const path = decodeURIComponent(
          String((params as { _splat?: string })._splat ?? "").replace(/^\/+/, ""),
        );
        const m = PATH_RE.exec(path);
        if (!m) return new Response("Not found", { status: 404 });
        const [, skuId, revisionRaw] = m;
        const revision = Number(revisionRaw);

        // 商品当前实测版本必须等于素材版本
        const { data: sku } = await supabaseAdmin
          .from("inv_skus")
          .select("id, measurement_revision")
          .eq("id", skuId)
          .maybeSingle();
        const skuRow = sku as unknown as { id: string; measurement_revision: number } | null;
        if (!skuRow || skuRow.measurement_revision !== revision) {
          return new Response("Not found", { status: 404 });
        }

        // 素材必须 verified ready 且路径一致（640 路径为规范记录，1280 派生自同一 base）
        const base640 = `sku-listing/measurements/${skuId}/${path.split("/")[2].replace(/-1280\.png$/, "-640.png")}`;
        const { data: asset } = await supabaseAdmin
          .from("product_measurement_assets" as never)
          .select("sku_id")
          .eq("sku_id", skuId)
          .eq("revision", revision)
          .eq("status", "ready")
          .eq("verified", true)
          .eq("cutout_preview_path", base640)
          .limit(1);
        if (!asset || (asset as unknown[]).length === 0) {
          return new Response("Not found", { status: 404 });
        }

        // 商品必须处于公开可读的 listing 状态
        const { data: listing } = await supabaseAdmin
          .from("commerce_listings" as never)
          .select("id, status, published_at")
          .eq("sku_id", skuId)
          .in("status", ["published", "reserved", "sold", "archived"])
          .limit(1);
        const readable = ((listing as unknown as Array<{ status: string; published_at: string | null }>) ?? []).some(
          (l) => l.status === "published" || l.published_at,
        );
        if (!readable) return new Response("Not found", { status: 404 });

        const { data, error } = await supabaseAdmin.storage.from("sku-listing").download(path);
        if (error || !data) return new Response("Not found", { status: 404 });
        const buffer = await data.arrayBuffer();
        return new Response(buffer, {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=31536000, immutable",
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    },
  },
});
