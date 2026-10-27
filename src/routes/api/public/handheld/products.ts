// GET /api/public/handheld/products: explicit HQ all or one authorized location.
import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok } from "@/server/handheld-auth.server";
import {
  authorizeProductScope,
  loadProductInventory,
  loadScopedProductSkus,
  filterProductSearch,
  buildProductItems,
  signProductItems,
  productReadError,
  loadStorePublishedAt,
  type ProductItem,
} from "@/server/handheld-products.server";
import { compareListed, resolveListedAt, storePublishedAtMap } from "@/lib/handheld/listed-at";
export type { ProductItem } from "@/server/handheld-products.server";

export const Route = createFileRoute("/api/public/handheld/products")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        try {
          const auth = await authenticateDevice(request);
          if (!auth.ok) return auth.response;
          const scoped = await authorizeProductScope(request, auth.device);
          const params = new URL(request.url).searchParams;
          const q = (params.get("q") || "").trim();
          const type = (params.get("type") || "all").toLowerCase();
          const status = (params.get("status") || "all").toLowerCase();
          const category = (params.get("category") || "").trim();
          const hasImage = params.get("has_image");
          const sort = (params.get("sort") || "").toLowerCase();
          const onlyFankuang = ["1", "true"].includes(params.get("fankuang") || "");
          const page = Math.max(1, Number(params.get("page") || "1") | 0);
          const pageSize = Math.min(500, Math.max(1, Number(params.get("page_size") || "50") | 0));
          const inventory = await loadProductInventory(scoped);
          const skus = await loadScopedProductSkus(inventory, (query) => {
            let result = filterProductSearch(query, q);
            if (category) result = result.eq("category", category);
            return result;
          });
          let items = buildProductItems(skus, inventory).filter((item) => {
            if (onlyFankuang && !item.in_fankuang) return false;
            if (status !== "all" && item.listing_status !== status) return false;
            if (item.product_type !== "custom") return true;
            if (hasImage === "1") return item.image_paths.length > 0;
            if (hasImage === "0") return item.image_paths.length === 0;
            return true;
          });
          // Badges are type-independent, but share every other list filter.
          const counts = { custom: 0, bundle: 0, standard: 0, all: items.length };
          for (const item of items) counts[item.product_type] += 1;
          if (type !== "all") items = items.filter((item) => item.product_type === type);

          // 上架时间：仅本店 commerce_listings.published_at，缺失回退 SKU created_at；排序在分页前。
          const listings = await loadStorePublishedAt(inventory, items.map((i) => i.id));
          const published = storePublishedAtMap(listings.rows, listings.storeLocationId);
          const listedItems = items.map((item) => ({ ...item, ...resolveListedAt(item, published) }));
          type ListedItem = (typeof listedItems)[number];

          const rank = { custom: 0, bundle: 1, standard: 2 };
          const compare = (a: ListedItem, b: ListedItem): number => {
            if (sort === "listed_desc") return compareListed(a, b, "desc");
            if (sort === "listed_asc") return compareListed(a, b, "asc");
            if (sort === "created_desc") return b.created_at.localeCompare(a.created_at);
            if (sort === "created_asc") return a.created_at.localeCompare(b.created_at);
            if (sort === "price_desc") return b.price - a.price;
            if (sort === "price_asc") return a.price - b.price;
            if (sort === "stock_desc") return b.total_stock_qty - a.total_stock_qty;
            return (
              rank[a.product_type] - rank[b.product_type] ||
              b.updated_at.localeCompare(a.updated_at)
            );
          };
          listedItems.sort((a, b) => compare(a, b) || a.id.localeCompare(b.id));
          items = listedItems;
          const total = items.length;
          const from = (page - 1) * pageSize;
          const responseItems = await signProductItems(items.slice(from, from + pageSize));
          return ok({
            scope: scoped.scope,
            items: responseItems,
            total,
            page,
            page_size: pageSize,
            counts,
          });
        } catch (error) {
          return productReadError(error);
        }
      },
    },
  },
});
