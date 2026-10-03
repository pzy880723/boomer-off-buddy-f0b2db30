import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { signSkuImagePaths } from "@/lib/sku-image-resolver.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";
import { isPosBrand } from "@/lib/pos/brand-catalog";
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

        const { locationInheritsStandardCatalog } =
          await import("@/server/standard-catalog-scope.server");
        const inherits = await locationInheritsStandardCatalog(locationId);
        if (!inherits) {
          return posJson({ ok: true, data: { location_id: locationId, groups: [] } });
        }

        const [categoriesResult, skusResult, brandsResult, charactersResult] = await Promise.all([
          supabaseAdmin
            .from("inv_categories")
            .select("id,code,name,parent_id,is_active,sort_order")
            .eq("is_active", true),
          supabaseAdmin
            .from("inv_skus")
            .select("id,category,name,price_tier,image_paths,image_url")
            .in("category", STANDARD_CATEGORY_CODES)
            .eq("kind", "single")
            .eq("is_custom_price", false)
            .eq("inventory_policy", "unlimited")
            .eq("is_display", true)
            .eq("status", "active"),
          supabaseAdmin.from("inv_brands")
            .select("id,name,aliases,category_codes,entity_type,status")
            .eq("status", "active").order("name").limit(1000),
          supabaseAdmin.from("inv_facets").select("id,code,name,aliases,category_codes")
            .eq("dimension", "character").eq("is_active", true).order("sort_order").order("name").limit(1000),
        ]);
        if (categoriesResult.error) return posError(categoriesResult.error.message, 500);
        if (skusResult.error) return posError(skusResult.error.message, 500);
        if (charactersResult.error) return posError(charactersResult.error.message, 500);
        if (brandsResult.error) return posError(brandsResult.error.message, 500);

        const groups = buildStandardCatalog(
          (categoriesResult.data ?? []) as unknown as CategoryRowLike[],
          (skusResult.data ?? []) as unknown as StandardSkuRowLike[],
        );
        const covers = await signSkuImagePaths(groups.map((group) => group.image_url ?? ""));
        groups.forEach((group, index) => {
          group.image_url = covers[index] ?? null;
        });
        const brands = (brandsResult.data ?? []).filter(isPosBrand)
          .map(({ id, name, aliases, category_codes }) => ({ id, name, aliases, category_codes }));
        return posJson({ ok: true, data: { location_id: locationId, groups, brands, characters: charactersResult.data ?? [] } });
      },
    },
  },
});
