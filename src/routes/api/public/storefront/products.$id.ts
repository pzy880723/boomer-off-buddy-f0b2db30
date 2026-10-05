import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { STOREFRONT_CORS, storefrontError, storefrontJson } from "@/server/storefront-auth.server";
import { signDerivativeUrls } from "@/server/media-derivative.server";
import { loadPublishedProductContent } from "@/server/product-content.server";
import { loadTencentMediaManifest, tencentDerivative } from "@/server/storefront-tencent-media.server";
import {
  enrichStorefrontListings,
  signStorefrontProductImages,
  type StorefrontListing,
} from "@/server/storefront-products.server";

export const Route = createFileRoute("/api/public/storefront/products/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ params, request }) => {
        const { data, error } = await supabaseAdmin
          .from("commerce_listings" as never)
          .select(
            "id, sku_id, location_id, title, description, cover_url, image_urls, image_paths, price, compare_at_price, condition_grade, product_type, published_at, location:inv_locations!location_id(id,name,kind),sku:inv_skus!sku_id(image_jobs:inv_listing_image_jobs(status,source_bucket,source_path,target_path,updated_at))",
          )
          .eq("id", params.id)
          .eq("status", "published")
          .maybeSingle();
        if (error) return storefrontError(error.message, 500);
        if (!data) return storefrontError("Product not found", 404);
        try {
          const listing = data as unknown as StorefrontListing;
          const tencent = new URL(request.url).searchParams.get("media") === "tencent-v1";
          const [products, content, manifest] = await Promise.all([
            enrichStorefrontListings([listing], { signImages: false }),
            loadPublishedProductContent(listing.sku_id),
            tencent ? loadTencentMediaManifest() : Promise.resolve(null),
          ]);
          if (!products[0] || products[0].stock < 1) {
            return storefrontError("Product not available", 404);
          }
          const signed = await signStorefrontProductImages(products, new Map([[listing.id, listing]]), { thumbnail: true, tencentManifest: manifest });
          const product = signed[0];
          const originals = [...new Set([product.image_url, ...product.image_urls].filter((url): url is string => Boolean(url)))];
          const previews = originals.map(source => tencentDerivative(source, 1280, manifest));
          const missing = originals.map((source, index) => ({ source, index })).filter(row => !previews[row.index]);
          if (missing.length) {
            const fallback = await signDerivativeUrls(missing.map(row => row.source), 960);
            missing.forEach((row, index) => { previews[row.index] = fallback[index] ?? null; });
          }
          return storefrontJson({ ok: true, data: { ...product,
            detail_content: content?.published_blocks ?? [],
            detail_content_version: content?.version ?? 0,
            image_previews: originals.map((image_url, index) => ({ image_url, preview_url: previews[index] ?? null })) } });
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
