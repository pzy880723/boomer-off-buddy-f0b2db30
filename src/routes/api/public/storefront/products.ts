import { createFileRoute } from "@tanstack/react-router";
import { STOREFRONT_CORS, storefrontJson } from "@/server/storefront-auth.server";
import {
  parseStorefrontProductQuery,
  signStorefrontProductImages,
} from "@/server/storefront-products.server";
import { loadStorefrontCatalog } from "@/server/storefront-catalog.server";
import { filterStorefrontProducts } from "@/server/storefront-filters";
import { loadTencentMediaManifest } from "@/server/storefront-tencent-media.server";

export const Route = createFileRoute("/api/public/storefront/products")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const query = parseStorefrontProductQuery(url);
        try {
          const tencent = url.searchParams.get("media") === "tencent-v1";
          const [catalog, manifest] = await Promise.all([
            loadStorefrontCatalog(query), tencent ? loadTencentMediaManifest() : Promise.resolve(null),
          ]);
          const availableProducts = filterStorefrontProducts(catalog.products, query).sort((left, right) => {
            if (query.sort === "price_asc") return left.price - right.price;
            if (query.sort === "price_desc") return right.price - left.price;
            if (query.sort === "relevance") return (catalog.rank.get(right.sku_id) ?? 0) - (catalog.rank.get(left.sku_id) ?? 0);
            return String(right.published_at ?? "").localeCompare(String(left.published_at ?? ""));
          });
          const total = availableProducts.length;
          const start = (query.page - 1) * query.page_size;
          const pageProducts = availableProducts.slice(start, start + query.page_size);
          const products = await signStorefrontProductImages(pageProducts, catalog.listingsById, { thumbnail: true, originals: !tencent, tencentManifest: manifest });
          return storefrontJson({
            ok: true,
            data: products,
            pagination: { page: query.page, page_size: query.page_size, total },
            filters: query,
          });
        } catch {
          return storefrontJson(
            {
              ok: false,
              error: "商品元数据加载失败，请重试",
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
