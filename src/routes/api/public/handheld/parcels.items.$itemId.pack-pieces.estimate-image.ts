/**
 * POST /api/public/handheld/parcels/items/{itemId}/pack-pieces/estimate-image
 * super_admin 独占。用 item 的图片 + 标题跑 AI 视觉识别整包件数。
 * body: 无（服务端从 DB 读 title / title_cn / item_image_url，并选缩略图）
 */
import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, ok } from "@/server/handheld-auth.server";
import { errCode } from "@/lib/handheld/errors";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSuperAdmin } from "./parcels";
import { toThumbUrl } from "@/lib/image";
import { generateText, Output } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

const ResultSchema = z.object({
  pieces: z.number().int().min(1).max(100000).nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string().max(200),
  unit: z.string().max(8).nullable().optional(),
});

const IMAGE_SYSTEM = `你是日本代购商品"打包件数"图像分析助手。
任务：数清楚图片里这件商品里有几个可独立售出的"小件"（用于单价拆分）。
注意：
- 一盒卡牌、一整袋小物件、一堆杂货 → 尽量数清楚可见数量
- 单一物品 → 1
- 完全数不清/重叠遮挡严重 → pieces=null，置信度 low
- 不要把单件商品的零件分别算（比如手办的底座+本体算 1 件）
输出 JSON：{"pieces": number|null, "confidence": "high"|"medium"|"low", "reasoning": "简短中文说明", "unit": "..."|null}`;

export const Route = createFileRoute(
  "/api/public/handheld/parcels/items/$itemId/pack-pieces/estimate-image",
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
          .select("id, item_title, item_title_cn, item_image_url")
          .eq("id", idParse.data)
          .maybeSingle();
        if (error) return errCode("internal_error", error.message);
        if (!item) return errCode("not_found", "Item not found");
        if (!item.item_image_url) return errCode("validation_error", "无图片");

        const imgUrl = toThumbUrl(item.item_image_url, 1024) ?? item.item_image_url;
        const text = [item.item_title_cn, item.item_title].filter(Boolean).join(" / ").trim();

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
            messages: [
              { role: "system", content: IMAGE_SYSTEM },
              {
                role: "user",
                content: [
                  { type: "text", text: `商品标题：${text || "(无)"}` },
                  { type: "image", image: new URL(imgUrl) },
                ],
              },
            ],
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
