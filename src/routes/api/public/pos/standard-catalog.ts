import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";
import {
  STANDARD_CATEGORY_CODES,
  buildStandardCatalog,
  type CategoryRowLike,
  type StandardSkuRowLike,
} from "@/lib/pos/standard-catalog";

export const Route = createFileRoute("/api/public/pos/standard-catalog")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const locationId = url.searchParams.get("location_id")?.trim();
        if (!locationId) return posError("location_id 必填", 400);
        const auth = await authenticatePosUser(request, locationId);
        if (!auth.ok) return auth.response;

        const { locationInheritsStandardCatalog } = await import(
          "@/server/standard-catalog-scope.server"
        );
        const inherits = await locationInheritsStandardCatalog(locationId);
        if (!inherits) {
          return posJson({ ok: true, data: { location_id: locationId, groups: [] } });
        }

        const [categoriesResult, skusResult] = await Promise.all([
          supabaseAdmin
            .from("inv_categories")
            .select("id,code,name,parent_id,is_active,sort_order")
            .eq("is_active", true),
          supabaseAdmin
            .from("inv_skus")
            .select("id,category,name,price_tier")
            .in("category", STANDARD_CATEGORY_CODES)
            .eq("kind", "single")
            .eq("is_custom_price", false)
            .eq("inventory_policy", "unlimited")
            .eq("is_display", true)
            .eq("status", "active"),
        ]);
        if (categoriesResult.error) return posError(categoriesResult.error.message, 500);
        if (skusResult.error) return posError(skusResult.error.message, 500);

        const groups = buildStandardCatalog(
          (categoriesResult.data ?? []) as unknown as CategoryRowLike[],
          (skusResult.data ?? []) as unknown as StandardSkuRowLike[],
        );
        return posJson({ ok: true, data: { location_id: locationId, groups } });
      },
    },
  },
});
