import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { STOREFRONT_CORS, storefrontJson } from "@/server/storefront-auth.server";
import {
  buildPublicShops,
  signShopImages,
  SHOP_IMAGE_TTL,
  type ShopSourceRow,
} from "@/server/storefront-shops.server";

export const Route = createFileRoute("/api/public/storefront/shops")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async () => {
        const { data, error } = await supabaseAdmin
          .from("youzan_shops" as never)
          .select(
            "id, shop_name, status, address, image_url, location:inv_locations!shop_id(id,name,kind,is_active)",
          )
          .eq("status", "active");
        if (error) return storefrontJson({ ok: false, error: error.message }, { status: 500 });

        const rows = ((data ?? []) as unknown as Array<
          Omit<ShopSourceRow, "location"> & {
            location: ShopSourceRow["location"] | ShopSourceRow["location"][] | null;
          }
        >).map((row) => ({
          ...row,
          location: Array.isArray(row.location) ? (row.location[0] ?? null) : row.location,
        })) as ShopSourceRow[];

        const shops = await buildPublicShops(rows, signShopImages);
        return storefrontJson(
          { ok: true, data: shops },
          {
            // 含短期签名图片，只允许浏览器私有缓存，且短于签名有效期
            headers: { "Cache-Control": `private, max-age=${Math.floor(SHOP_IMAGE_TTL / 5)}` },
          },
        );
      },
    },
  },
});
