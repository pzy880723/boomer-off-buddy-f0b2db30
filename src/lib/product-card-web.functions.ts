import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Web entry reuses the existing card builder; no save, export or print implementation here. */
export const generateWebProductCard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid(), location_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const [rolesRes, permsRes] = await Promise.all([
      sb.from("user_roles").select("role").eq("user_id", context.userId),
      sb.from("user_location_perms").select("location_id").eq("user_id", context.userId),
    ]);
    if (rolesRes.error || permsRes.error) throw new Response("权限读取失败", { status: 403 });
    const roles = (rolesRes.data ?? []).map((r) => String(r.role));
    const allowed = roles.some((r) => r === "super_admin" || r === "hq_operator") ||
      (roles.includes("store_manager") && (permsRes.data ?? []).some((p) => p.location_id === data.location_id));
    if (!allowed) throw new Response("库位未授权", { status: 403 });
    const { buildRecommendationCard, generateCardCopy } = await import("@/server/recommendation-card.server");
    const { webErpAiGuard } = await import("@/server/ai-guard");
    const { signSkuImagePaths } = await import("@/lib/sku-image-resolver.server");
    const { data: location, error } = await sb.from("inv_locations").select("is_active").eq("id", data.location_id).maybeSingle();
    if (error || !location?.is_active) throw new Response("库位不可用", { status: 403 });
    const { data: stock, error: stockErr } = await sb.from("inv_stocks").select("sku_id").eq("sku_id", data.id).eq("location_id", data.location_id).maybeSingle();
    if (stockErr || !stock) throw new Response("商品不属于当前库位", { status: 403 });
    const result = await buildRecommendationCard({
      canAccessLocation: async () => allowed,
      loadSku: async (id) => {
        const { data: sku, error } = await sb.from("inv_skus").select("id,name,category,grade,status,sku_scope,brand_id,ip_id,keywords,image_paths").eq("id", id).maybeSingle();
        if (error) throw error;
        return sku;
      },
      hasStockAt: async () => Boolean(stock),
      entityNames: async (ids) => {
        if (!ids.length) return new Map();
        const { data: names, error } = await sb.from("inv_brands").select("id,name").in("id", ids);
        if (error) throw error;
        return new Map((names ?? []).map((r) => [r.id, r.name]));
      },
      signImage: async (path) => (await signSkuImagePaths([path]))[0] ?? null,
      publishedDescription: async (id, loc) => {
        const { data: listing, error } = await sb.from("commerce_listings").select("description").eq("sku_id", id).eq("location_id", loc).eq("status", "published").maybeSingle();
        if (error) throw error;
        return listing?.description ?? null;
      },
      generate: (facts, retry) => generateCardCopy(facts, retry, webErpAiGuard()),
    }, { userId: context.userId, locationId: data.location_id, skuId: data.id });
    if (!result.ok) throw new Response(result.code, { status: result.status });
    return result.card;
  });