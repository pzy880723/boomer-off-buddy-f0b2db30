import { beforeHandheldAiOutbound, type AiOutboundGuard } from "./ai-guard.ts";
import { listingAiFetch, LISTING_AI_DIRECT_URL } from "./listing-ai-transport.server.ts";
import { normalizeAutoProductTitle } from "../lib/product-title-text.ts";
export const PRODUCT_TITLE_PROMPT = `你是 BOOMER-OFF 中古杂货命名助手。只返回 JSON {"name":"标题"}。
根据照片写一个中文商品标题，目标 12-20 个字，最多不超过 24 个字；优先写出照片可确认的 IP/角色、物件名或型号，再补一个可见的造型、色彩或功能，简短鲜活有吸引力，不要官方参数堆砌。
禁止猜测品牌、年代或真伪，禁止无依据添加限定、绝版、收藏级、稀有等词。不确定具体型号时使用物件名。不要输出分析或解释。`;

/** Default send: the configured listing AI transport (fixed private relay when configured, else direct). */
const transportSend = (apiKey: string): typeof fetch =>
  (async (_url: unknown, init?: RequestInit) =>
    listingAiFetch(String(init?.body ?? ""), apiKey, init?.signal ?? undefined)) as typeof fetch;

export async function recognizeProductTitle(
  imageBase64: string,
  guard: AiOutboundGuard,
  send?: typeof fetch,
  apiKey = process.env.LOVABLE_API_KEY,
): Promise<string> {
  if (!apiKey) throw new Error("AI unavailable");
  const body = JSON.stringify({ model: process.env.HANDHELD_PRODUCT_RECOGNITION_MODEL || "google/gemini-2.5-flash",
    max_tokens: 256, response_format: { type: "json_object" },
    messages: [{ role: "system", content: PRODUCT_TITLE_PROMPT },
      { role: "user", content: [{ type: "image_url", image_url: {
        url: imageBase64.startsWith("data:") ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`,
      } }] }],
  });
  const doSend = send ?? transportSend(apiKey);
  // Guard immediately before the single outbound request; denial throws, nothing is sent.
  await beforeHandheldAiOutbound(guard, "product_title");
  const response = await doSend(LISTING_AI_DIRECT_URL, {
    method: "POST", signal: AbortSignal.timeout(6_000),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body,
  });
  if (!response.ok) throw new Error(`AI title unavailable (${response.status})`);
  const payload = await response.json();
  const parsed = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}");
  if (typeof parsed.name !== "string" || !parsed.name.trim()) throw new Error("AI title missing");
  const title = normalizeAutoProductTitle(parsed.name);
  if (!title) throw new Error("AI title missing");
  return title;
}
