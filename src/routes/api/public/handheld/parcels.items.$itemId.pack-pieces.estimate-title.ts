/**
 * POST /api/public/handheld/parcels/items/{itemId}/pack-pieces/estimate-title
 * super_admin 独占。用 item 的标题跑 AI（Lovable Gateway）判断整包件数。
 * body: 无（服务端从 DB 读 title / title_cn）
 */
import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, ok } from "@/server/handheld-auth.server";
import { errCode } from "@/lib/handheld/errors";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSuperAdmin } from "./parcels";
import { generateText, Output } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

const ResultSchema = z.object({
  pieces: z.number().int().min(1).max(100000).nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string().max(200),
  unit: z.string().max(8).nullable().optional(),
});

const TITLE_SYSTEM = `你是日本代购商品"打包件数"分析助手。
任务：根据商品标题判断这个商品里实际包含几个"小件"（用于单价拆分）。
注意：
- "100枚セット" / "30点まとめ" / "5個入り" / "12本セット" / "20冊" → 直接给出数字
- "ガチャ 1回" / "フィギュア 1個" / 单件商品 → 1
- "コンプ" 套装+前面的数字（如 "5種コンプ" → 5）
- "詰め合わせ" / "アソート" / "ジャンク まとめ" 没明确数字 → pieces=null
- 含糊不清、量词无法判断 → pieces=null，不要瞎猜
unit 字段：从标题里推单位（枚=张、点/個/本/冊/箱→ 个/本/册/箱），不确定填 null。
输出 JSON：{"pieces": number|null, "confidence": "high"|"medium"|"low", "reasoning": "简短中文说明", "unit": "..."|null}`;

export const Route = createFileRoute(
  "/api/public/handheld/parcels/items/$itemId/pack-pieces/estimate-title",
)({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const g = await requireSuperAdmin(request);
        if (!g.ok) return g.response;

        const idParse = z.string().uuid().safeParse(params.itemId);
        if (!idParse.success) return errCode("invalid_body", "Invalid item id");

        const { data: item, error } = await supabaseAdmin
          .from("japan_parcel_items")
          .select("id, item_title, item_title_cn")
          .eq("id", idParse.data)
          .maybeSingle();
        if (error) return errCode("internal_error", error.message);
        if (!item) return errCode("not_found", "Item not found");

        const text = [item.item_title_cn, item.item_title].filter(Boolean).join(" / ").trim();
        if (!text) return errCode("validation_error", "标题为空");

        const apiKey = process.env.LOVABLE_API_KEY;
        if (!apiKey) return errCode("internal_error", "LOVABLE_API_KEY not configured");

        try {
          const gateway = createOpenAICompatible({
            name: "lovable",
            baseURL: "https://ai.gateway.lovable.dev/v1",
            headers: { "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
          });
          const { output } = await generateText({
            model: gateway("google/gemini-2.5-flash"),
            output: Output.object({ schema: ResultSchema }),
            system: TITLE_SYSTEM,
            messages: [{ role: "user", content: `商品标题：${text}` }],
          });
          return ok({
            pieces: output.pieces ?? null,
            confidence: output.confidence,
            reasoning: output.reasoning,
            unit: output.unit ?? null,
          });
        } catch (e) {
          const msg = (e as Error).message ?? "";
          if (/rate.?limit|429/i.test(msg)) return errCode("rate_limited", msg);
          if (/credit|402/i.test(msg)) return errCode("ai_credits_exhausted", msg);
          return errCode("internal_error", msg);
        }
      },
    },
  },
});
