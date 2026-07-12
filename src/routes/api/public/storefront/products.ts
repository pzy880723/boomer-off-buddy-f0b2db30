import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { STOREFRONT_CORS, storefrontJson } from "@/server/storefront-auth.server";

export const Route = createFileRoute("/api/public/storefront/products")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const category = url.searchParams.get("category");
        const query = url.searchParams.get("q")?.trim();
        const locationId = url.searchParams.get("location_id");
        const page = Math.max(1, Number(url.searchParams.get("page") || 1));
        const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get("page_size") || 20)));
        let db = supabaseAdmin
          .from("commerce_listings" as never)
          .select(
            "id, sku_id, location_id, title, description, cover_url, image_urls, price, compare_at_price, condition_grade, category, published_at, location:inv_locations!location_id(id,name,kind)",
            { count: "exact" },
          )
          .eq("status", "published")
          .order("published_at", { ascending: false })
          .range((page - 1) * pageSize, page * pageSize - 1);
        if (category) db = db.eq("category", category);
        if (locationId) db = db.eq("location_id", locationId);
        if (query) db = db.ilike("title", `%${query.replace(/[%_]/g, "")}%`);
        const { data, error, count } = await db;
        if (error) return storefrontJson({ ok: false, error: error.message }, { status: 500 });
        return storefrontJson({
          ok: true,
          data: data ?? [],
          pagination: { page, page_size: pageSize, total: count ?? 0 },
        });
      },
    },
  },
});
