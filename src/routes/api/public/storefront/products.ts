import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { STOREFRONT_CORS, storefrontJson } from "@/server/storefront-auth.server";
import {
  enrichStorefrontListings,
  parseStorefrontProductQuery,
  type StorefrontListing,
} from "@/server/storefront-products.server";

export const Route = createFileRoute("/api/public/storefront/products")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const query = parseStorefrontProductQuery(url);
        const { data: matches, error: searchError } = await supabaseAdmin.rpc(
          "search_inv_skus" as never,
          {
            p_query: query.q,
            p_primary_category: query.primary_category,
            p_brand_ids: query.brand_ids,
            p_facet_codes: query.facet_codes,
            p_limit: 500,
            p_offset: 0,
          } as never,
        );
        if (searchError) {
          return storefrontJson({ ok: false, error: searchError.message }, { status: 500 });
        }
        const ranked = (matches ?? []) as unknown as Array<{
          sku_id: string;
          search_rank: number;
        }>;
        const skuIds = ranked.map((item) => item.sku_id);
        if (skuIds.length === 0) {
          return storefrontJson({
            ok: true,
            data: [],
            pagination: { page: query.page, page_size: query.page_size, total: 0 },
            filters: query,
          });
        }

        let db = supabaseAdmin
          .from("commerce_listings" as never)
          .select(
            "id, sku_id, location_id, title, description, cover_url, image_urls, price, compare_at_price, condition_grade, product_type, published_at, location:inv_locations!location_id(id,name,kind)",
          )
          .eq("status", "published")
          .in("sku_id", skuIds)
          .limit(500);
        if (query.location_id) db = db.eq("location_id", query.location_id);
        const { data, error } = await db;
        if (error) return storefrontJson({ ok: false, error: error.message }, { status: 500 });

        const rank = new Map(ranked.map((item) => [item.sku_id, item.search_rank]));
        const listings = ((data ?? []) as unknown as StorefrontListing[]).sort((left, right) => {
          if (query.sort === "price_asc") return Number(left.price) - Number(right.price);
          if (query.sort === "price_desc") return Number(right.price) - Number(left.price);
          if (query.sort === "relevance") {
            return (rank.get(right.sku_id) ?? 0) - (rank.get(left.sku_id) ?? 0);
          }
          return String(right.published_at ?? "").localeCompare(String(left.published_at ?? ""));
        });
        try {
          const availableProducts = (await enrichStorefrontListings(listings)).filter(
            (product) => product.stock > 0,
          );
          const total = availableProducts.length;
          const start = (query.page - 1) * query.page_size;
          const products = availableProducts.slice(start, start + query.page_size);
          return storefrontJson({
            ok: true,
            data: products,
            pagination: { page: query.page, page_size: query.page_size, total },
            filters: query,
          });
        } catch (metadataError) {
          return storefrontJson(
            {
              ok: false,
              error: metadataError instanceof Error ? metadataError.message : "商品元数据加载失败",
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
