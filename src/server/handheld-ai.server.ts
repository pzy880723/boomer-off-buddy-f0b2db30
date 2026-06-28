// Server-only AI helpers for handheld smart-create flow.
// Default models per project memory: gemini-2.5-pro 识别, gemini-3.1-flash-image 修图.
// 走 Lovable AI Gateway, 不需要单独 key.
import { z } from "zod";

const GATEWAY = "https://ai.gateway.lovable.dev/v1";

function getKey(): string {
  const k = process.env.LOVABLE_API_KEY;
  if (!k) throw new Error("LOVABLE_API_KEY not configured");
  return k;
}

const RecognizeSchema = z.object({
  name: z.string(),
  category: z
    .enum([
      "jp_porcelain",
      "eu_porcelain",
      "vintage_toy",
      "anime_goods",
      "media",
      "digital",
      "jewelry",
      "fashion",
      "daily",
      "antique",
    ])
    .nullable(),
  brand: z.string().nullable(),
  era: z.string().nullable(),
  condition_grade: z.enum(["N", "S", "A", "B", "C", "J"]).nullable(),
  description: z.string().nullable(),
  suggested_price_cny: z.number().nullable(),
});

const SYSTEM_RECOGNIZE = `你是中古杂货识别助手。看图后只输出 JSON。
category 枚举：jp_porcelain(日本瓷器) / eu_porcelain(欧洲瓷器) / vintage_toy(中古玩具) / anime_goods(二次元周边) / media(音像) / digital(数码家电) / jewelry(珠宝) / fashion(时尚配件) / daily(日用) / antique(古美术)。
condition_grade：N全新 / S近全新 / A良好 / B一般 / C较旧 / J有瑕疵。
era 用 1970s / 昭和后期 这种粒度，不知就 null。
suggested_price_cny 给整数 RMB 估值，没把握就 null。
不知道的字段一律 null，不要瞎编。`;

function toDataUrl(input: { image_url?: string; image_base64?: string }): string {
  if (input.image_url) return input.image_url;
  const b64 = input.image_base64 || "";
  return b64.startsWith("data:") ? b64 : `data:image/jpeg;base64,${b64}`;
}

export async function aiRecognizeItem(input: {
  image_url?: string;
  image_base64?: string;
  images?: Array<{ image_url?: string; image_base64?: string }>;
  hint?: string;
}) {
  // v1.2：最多 4 张图，images[0] 视为主图
  const sources: Array<{ image_url?: string; image_base64?: string }> = [];
  if (input.images && input.images.length > 0) {
    sources.push(...input.images.slice(0, 4));
  } else if (input.image_url || input.image_base64) {
    sources.push({ image_url: input.image_url, image_base64: input.image_base64 });
  }
  if (sources.length === 0) throw new Error("no image provided");

  const imageParts = sources.map((s) => ({
    type: "image_url" as const,
    image_url: { url: toDataUrl(s) },
  }));

  const hintLine = input.hint
    ? `店员补充：${input.hint}\n`
    : "";
  const multiNote =
    sources.length > 1
      ? `共 ${sources.length} 张图，第 1 张是主图，其余为细节/不同角度，请综合判断。\n`
      : "";

  const body = {
    model: "google/gemini-2.5-pro",
    messages: [
      { role: "system", content: SYSTEM_RECOGNIZE },
      {
        role: "user",
        content: [
          { type: "text", text: `${hintLine}${multiNote}请按要求输出 JSON。` },
          ...imageParts,
        ],
      },
    ],
    response_format: { type: "json_object" },
  };

  const res = await fetch(`${GATEWAY}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getKey()}`,
      "Content-Type": "application/json",
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`AI gateway ${res.status}: ${t.slice(0, 300)}`);
  }
  const j = await res.json();
  const text: string = j?.choices?.[0]?.message?.content ?? "{}";
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = {};
  }
  const parsed = RecognizeSchema.partial().safeParse(raw);
  const out = parsed.success ? parsed.data : {};
  return {
    name: out.name ?? "",
    category: out.category ?? null,
    brand: out.brand ?? null,
    era: out.era ?? null,
    condition_grade: out.condition_grade ?? null,
    description: out.description ?? null,
    suggested_price_cny: out.suggested_price_cny ?? null,
    raw,
  };
}

const SYSTEM_LISTING_IMAGE = `把这张中古杂货实物图修整成上架主图：
- 校正角度，居中裁切
- 背景统一为干净浅灰底
- 修正白平衡和曝光
- 严禁改 logo、文字、瑕疵、颜色、配件数量
- 严禁添加任何文字、水印、贴纸`;

/** Returns base64 PNG (no data: prefix). */
export async function aiPrepareListingImage(input: {
  image_url?: string;
  image_base64?: string;
  instruction?: string;
}): Promise<{ b64: string; mime: string }> {
  const dataUrl = input.image_url
    ? input.image_url
    : input.image_base64?.startsWith("data:")
    ? input.image_base64
    : `data:image/jpeg;base64,${input.image_base64}`;

  const body = {
    model: "google/gemini-3.1-flash-image",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              SYSTEM_LISTING_IMAGE +
              (input.instruction ? `\n额外要求：${input.instruction}` : ""),
          },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    modalities: ["image", "text"],
  };

  const res = await fetch(`${GATEWAY}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getKey()}`,
      "Content-Type": "application/json",
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`AI gateway ${res.status}: ${t.slice(0, 300)}`);
  }
  const j = await res.json();
  // OpenRouter image response shape: choices[0].message.images[0].image_url.url (data: URL)
  const url: string | undefined =
    j?.choices?.[0]?.message?.images?.[0]?.image_url?.url ??
    j?.choices?.[0]?.message?.content?.[0]?.image_url?.url;
  if (!url || !url.startsWith("data:")) {
    throw new Error("AI gateway did not return an image");
  }
  const m = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("Unsupported image data URL");
  return { mime: m[1], b64: m[2] };
}
