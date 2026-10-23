import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, err, ok, resolveSessionUser } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { labelFacets } from "@/lib/attribute-labels";

type CategoryRow = { id: string; code: string; name: string; parent_id: string | null; sort_order: number | null };

// 员工上架用 ERP 分类字典：全量启用末级分类（不按商城库存过滤），中文名来自 inv_categories，code 不作显示名。
export const Route = createFileRoute("/api/public/handheld/product-taxonomy")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return err("Employee session required", 401, { code: "session_required" });
        const [catR, facetR] = await Promise.all([
          supabaseAdmin
            .from("inv_categories" as never)
            .select("id, code, name, parent_id, sort_order")
            .eq("kind", "category")
            .eq("is_active", true)
            .order("sort_order", { ascending: true }),
          supabaseAdmin
            .from("inv_facets" as never)
            .select("id, code, name, dimension, aliases, category_codes, sort_order")
            .eq("is_active", true)
            .order("dimension", { ascending: true })
            .order("sort_order", { ascending: true }),
        ]);
        const dbError = catR.error ?? facetR.error;
        if (dbError || !Array.isArray(catR.data) || !Array.isArray(facetR.data)) {
          return err("分类字典读取失败，请稍后重试", 503, { code: "taxonomy_unavailable" });
        }
        const rows = catR.data as unknown as CategoryRow[];
        const valid = (r: CategoryRow) => !!r.code && !!r.name?.trim() && r.name.trim() !== r.code;
        const roots = rows.filter((r) => r.parent_id === null && valid(r));
        const primary_categories = roots.map((root) => ({
          code: root.code,
          name: root.name.trim(),
          children: rows
            .filter((r) => r.parent_id === root.id && valid(r))
            .map((r) => ({ code: r.code, name: r.name.trim(), parent_code: root.code, parent_name: root.name.trim() })),
        }));
        const facets = labelFacets(
          facetR.data as unknown as Array<Record<string, unknown> & { dimension: string }>,
        );
        return ok({ primary_categories, facets });
      },
    },
  },
});
