import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { STOREFRONT_CORS, authenticateStorefrontCustomer, storefrontError } from "@/server/storefront-auth.server";
import { callFankuangRpc, fankuangOk } from "@/server/storefront-fankuang.server";
import {
  enrichStorefrontListings,
  signStorefrontProductImages,
  type StorefrontListing,
} from "@/server/storefront-products.server";
import { filterListingsForConsumerChannel, resolveRequestConsumerChannel } from "@/server/sales-channels.server";

// GET：当前冻结快照的商品卡（按快照顺序）；已售/下架项 available=false，不展示赠礼 SKU。
export const Route = createFileRoute("/api/public/storefront/fankuang/basket")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const r = await callFankuangRpc("commerce_fankuang_current_session", { p_customer_id: auth.customer.id });
        if (r instanceof Response) return r;
        const session = r.data as null | {
          id: string; listing_ids: string[]; flipped_listing_ids: string[]; unavailable_listing_ids: string[];
        };
        if (!session) return fankuangOk({ session: null, items: [] });
        const { data, error } = await supabaseAdmin
          .from("storefront_ready_listings" as never)
          .select(
            "id, sku_id, location_id, title, description, cover_url, image_urls, image_paths, price, compare_at_price, condition_grade, product_type, published_at, location:inv_locations!location_id(id,name,kind)",
          )
          .in("id", session.listing_ids);
        if (error) return storefrontError("商品加载失败", 500);
        const ready = (data ?? []) as unknown as StorefrontListing[];
        // 渠道展示过滤与商品列表一致：当前来源被显式关闭的商品在筐内显示为不可购（不展示商品卡）。
        let listings: StorefrontListing[];
        try {
          listings = await filterListingsForConsumerChannel(ready, await resolveRequestConsumerChannel(request));
        } catch {
          return storefrontError("商品渠道策略暂不可用", 503);
        }
        const channelVisible = new Set(listings.map((l) => l.id));
        try {
          const enriched = await enrichStorefrontListings(listings, { signImages: false });
          const byId = new Map(listings.map((l) => [l.id, l]));
          const signed = await signStorefrontProductImages(enriched, byId, { thumbnail: true });
          const productById = new Map(signed.map((p) => [p.id, p]));
          const unavailable = new Set([
            ...session.unavailable_listing_ids,
            ...ready.filter((l) => !channelVisible.has(l.id)).map((l) => l.id),
          ]);
          const flipped = new Set(session.flipped_listing_ids);
          const items = session.listing_ids.map((id) => ({
            listing_id: id,
            available: !unavailable.has(id),
            flipped: flipped.has(id),
            product: unavailable.has(id) ? null : productById.get(id) ?? null,
          }));
          return fankuangOk({ session, items });
        } catch {
          return storefrontError("商品加载失败", 500);
        }
      },
    },
  },
});
