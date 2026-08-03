import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { SKU_MEDIA_BUCKETS, type SkuMediaBucket } from "@/lib/sku-media";

/**
 * 商品图公开只读代理：/api/public/media/sku/<bucket>/<path>
 *
 * 仅用于把私有桶里的商品图暴露成外部渠道（有赞素材库 / 建品 picture / 市集）
 * 能直接抓取的稳定 URL。只读、只允许 sku-raw / sku-listing 两个桶。
 */
export const Route = createFileRoute("/api/public/media/sku/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const splat = String((params as { _splat?: string })._splat ?? "").replace(/^\/+/, "");
        const idx = splat.indexOf("/");
        if (idx <= 0) return new Response("Not found", { status: 404 });
        const bucket = splat.slice(0, idx) as SkuMediaBucket;
        const path = decodeURIComponent(splat.slice(idx + 1));
        if (!SKU_MEDIA_BUCKETS.includes(bucket) || !path || path.includes("..")) {
          return new Response("Not found", { status: 404 });
        }

        const { data, error } = await supabaseAdmin.storage.from(bucket).download(path);
        if (error || !data) return new Response("Not found", { status: 404 });

        const buffer = await data.arrayBuffer();
        return new Response(buffer, {
          status: 200,
          headers: {
            "Content-Type": data.type || "image/jpeg",
            "Cache-Control": "public, max-age=86400, immutable",
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    },
  },
});
