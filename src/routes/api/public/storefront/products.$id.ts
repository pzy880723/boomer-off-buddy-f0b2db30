import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { STOREFRONT_CORS, storefrontError, storefrontJson } from "@/server/storefront-auth.server";
import { loadPublishedProductContent } from "@/server/product-content.server";
import { loadEngagementCounts } from "@/server/storefront-engagement.server";
import {
  buildStorefrontProductDetail,
  STOREFRONT_DETAIL_READABLE_STATUSES,
  type StorefrontListing,
} from "@/server/storefront-products.server";

export const Route = createFileRoute("/api/public/storefront/products/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ params }) => {
        const { data, error } = await supabaseAdmin
          .from("commerce_listings" as never)
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
          return storefrontJson({ ok: true, data: { ...product, ...counts,
            detail_content: content?.published_blocks ?? [],
            detail_content_version: content?.version ?? 0,
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
