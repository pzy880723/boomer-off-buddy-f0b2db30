import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { STOREFRONT_CORS, storefrontError, storefrontJson } from "@/server/storefront-auth.server";

export const Route = createFileRoute("/api/public/storefront/products/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ params }) => {
        const { data, error } = await supabaseAdmin
          .from("commerce_listings" as never)
          .select(
            "id, sku_id, location_id, title, description, cover_url, image_urls, price, compare_at_price, condition_grade, category, published_at, location:inv_locations!location_id(id,name,kind)",
          )
          .eq("id", params.id)
          .eq("status", "published")
          .maybeSingle();
        if (error) return storefrontError(error.message, 500);
        if (!data) return storefrontError("Product not found", 404);
        return storefrontJson({ ok: true, data });
      },
    },
  },
});
