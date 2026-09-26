export const PRODUCT_TITLE_PROMPT = `你是 BOOMER-OFF 中古杂货命名助手。只返回 JSON {"name":"标题"}。
根据照片写一个不超过40字的中文商品标题，突出可见角色、造型、色彩或功能，简短鲜活有吸引力，不要官方参数堆砌。
禁止猜测品牌、年代或真伪，禁止无依据添加限定、绝版、收藏级、稀有等词。不确定具体型号时使用物件名。不要输出分析或解释。`;

export async function recognizeProductTitle(
  imageBase64: string,
  send: typeof fetch = fetch,
  apiKey = process.env.LOVABLE_API_KEY,
): Promise<string> {
  if (!apiKey) throw new Error("AI unavailable");
  const response = await send("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(6_000),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.HANDHELD_PRODUCT_RECOGNITION_MODEL || "google/gemini-2.5-flash",
      max_tokens: 256, response_format: { type: "json_object" },
      messages: [{ role: "system", content: PRODUCT_TITLE_PROMPT },
        { role: "user", content: [{ type: "image_url", image_url: {
          url: imageBase64.startsWith("data:") ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`,
        } }] }],
    }),
  });
  if (!response.ok) throw new Error(`AI title unavailable (${response.status})`);
  const payload = await response.json();
  const parsed = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}");
  if (typeof parsed.name !== "string" || !parsed.name.trim()) throw new Error("AI title missing");
  const title = parsed.name.replace(/(?:限定|绝版|收藏级|稀有|限量|保真|升值)/gu, "").trim().slice(0, 40);
  if (!title) throw new Error("AI title missing");
  return title;
}
