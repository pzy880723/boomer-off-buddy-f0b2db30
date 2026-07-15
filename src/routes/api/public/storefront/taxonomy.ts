import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { STOREFRONT_CORS, storefrontJson } from "@/server/storefront-auth.server";

export const Route = createFileRoute("/api/public/storefront/taxonomy")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const primaryCategory = url.searchParams.get("primary_category")?.trim() || null;
        const [categoryResult, brandResult, facetResult] = await Promise.all([
          supabaseAdmin
            .from("inv_categories" as never)
            .select("id, code, name, parent_id, sort_order")
            .eq("kind", "category")
            .eq("is_active", true)
            .order("sort_order", { ascending: true }),
          supabaseAdmin
            .from("inv_brands" as never)
            .select(
              "id, name, name_original, aliases, entity_type, origin_country, logo_url, category_codes",
            )
            .eq("status", "active")
            .order("name", { ascending: true }),
          supabaseAdmin
            .from("inv_facets" as never)
            .select("id, code, name, dimension, aliases, category_codes, sort_order")
            .eq("is_active", true)
            .order("dimension", { ascending: true })
            .order("sort_order", { ascending: true }),
        ]);
        const error = categoryResult.error ?? brandResult.error ?? facetResult.error;
        if (error) return storefrontJson({ ok: false, error: error.message }, { status: 500 });

        const categories = (categoryResult.data ?? []) as unknown as Array<{
          id: string;
          code: string;
          name: string;
          parent_id: string | null;
          sort_order: number;
        }>;
        const roots = categories.filter((row) => row.parent_id === null);
        const primary_categories = roots.map((root) => ({
          code: root.code,
          name: root.name,
          children: categories
            .filter((row) => row.parent_id === root.id)
            .map((row) => ({ code: row.code, name: row.name })),
        }));
        const selectedCategoryCodes = new Set<string>();
        if (primaryCategory) {
          selectedCategoryCodes.add(primaryCategory);
          const selected = categories.find((row) => row.code === primaryCategory);
          const parent = selected?.parent_id
            ? categories.find((row) => row.id === selected.parent_id)
            : null;
          if (parent) selectedCategoryCodes.add(parent.code);
        }
        const applies = (categoryCodes: string[]) =>
          !primaryCategory ||
          categoryCodes.length === 0 ||
          categoryCodes.some((code) => selectedCategoryCodes.has(code));
        const brands = (
          (brandResult.data ?? []) as unknown as Array<Record<string, unknown>>
        ).filter((row) => applies((row.category_codes as string[] | null) ?? []));
        const facets = (
          (facetResult.data ?? []) as unknown as Array<Record<string, unknown>>
        ).filter((row) => applies((row.category_codes as string[] | null) ?? []));
        return storefrontJson({
          ok: true,
          data: { primary_categories, brands, facets },
          selected_primary_category: primaryCategory,
        });
      },
    },
  },
});
