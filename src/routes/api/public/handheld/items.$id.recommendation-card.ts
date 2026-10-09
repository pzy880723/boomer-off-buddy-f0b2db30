// POST /api/public/handheld/items/{id}/recommendation-card
// 只读生成 60×90mm 商品推荐卡结构化内容；不保存、不改商品、不影响价格标签与上架。
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  HANDHELD_CORS,
  authenticateDevice,
  err,
  ok,
  resolveSessionUser,
  userCanAccessLocation,
} from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { signSkuImagePaths } from "@/lib/sku-image-resolver.server";
import { aiConsentBlock } from "@/server/ai-consent.server";
import { buildRecommendationCard, generateCardCopy } from "@/server/recommendation-card.server";

const Body = z.object({ location_id: z.string().uuid().optional() }).strict();

export const Route = createFileRoute("/api/public/handheld/items/$id/recommendation-card")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        try {
          const auth = await authenticateDevice(request);
          if (!auth.ok) return auth.response;
          const session = await resolveSessionUser(request);
          if (!session) return err("Employee session required", 401, { code: "session_required" });
          const parsed = Body.safeParse(await request.json().catch(() => ({})));
          if (!parsed.success || !z.string().uuid().safeParse(params.id).success)
            return err("Invalid request", 422, { code: "validation_error" });
          const locationId = parsed.data.location_id ?? auth.device.location_id;
          if (!locationId) return err("Location required", 422, { code: "validation_error" });

          const blocked = await aiConsentBlock(session.user_id);
          if (blocked) return blocked;
          const result = await buildRecommendationCard(
            {
              canAccessLocation: userCanAccessLocation,
              loadSku: async (id) => {
                const { data, error } = await supabaseAdmin
                  .from("inv_skus")
                  .select("id,name,category,grade,status,sku_scope,brand_id,ip_id,keywords,image_paths")
                  .eq("id", id)
                  .maybeSingle();
                if (error) throw error;
                return data;
              },
              hasStockAt: async (skuId, loc) => {
                const { data, error } = await supabaseAdmin
                  .from("inv_stocks")
                  .select("sku_id")
                  .eq("sku_id", skuId)
                  .eq("location_id", loc)
                  .maybeSingle();
                if (error) throw error;
                return !!data;
              },
              entityNames: async (ids) => {
                if (!ids.length) return new Map();
                const { data, error } = await supabaseAdmin.from("inv_brands").select("id,name").in("id", ids);
                if (error) throw error;
                return new Map((data ?? []).map((r) => [r.id, r.name]));
              },
              signImage: async (path) => (await signSkuImagePaths([path]))[0] ?? null,
              // 只读本门店已发布正文；不读 inv_skus.notes 等内部字段
              publishedDescription: async (skuId, loc) => {
                const { data, error } = await supabaseAdmin
                  .from("commerce_listings")
                  .select("description")
                  .eq("sku_id", skuId)
                  .eq("location_id", loc)
                  .eq("status", "published")
                  .maybeSingle();
                if (error) throw error;
                return data?.description ?? null;
              },
              generate: generateCardCopy,
            },
            { userId: session.user_id, locationId, skuId: params.id },
          );
          if (!result.ok) return err(result.code, result.status, { code: result.code });
          return ok(result.card);
        } catch {
          return err("Recommendation card unavailable", 500, { code: "internal_error" });
        }
      },
    },
  },
});
