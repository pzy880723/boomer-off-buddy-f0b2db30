// Server-only AI helpers for handheld smart-create flow.
// 默认模型：gemini-2.5-pro 识别，gemini-3.1-flash-image 修图。
// 走 Lovable AI Gateway，无需单独 key。
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const GATEWAY = "https://ai.gateway.lovable.dev/v1";

function getKey(): string {
  const k = process.env.LOVABLE_API_KEY;
  if (!k) throw new Error("LOVABLE_API_KEY not configured");
  return k;
}

const CATEGORY_ENUM = [
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
] as const;

const AltSchema = z.object({
  name: z.string(),
  category: z.enum(CATEGORY_ENUM).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

const RecognizeSchema = z.object({
  name: z.string(),
  category: z.enum(CATEGORY_ENUM).nullable(),
  brand: z.string().nullable(),
  era: z.string().nullable(),
  condition_grade: z.enum(["N", "S", "A", "B", "C", "J"]).nullable(),
  description: z.string().nullable(),
  suggested_price_cny: z.number().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  warning: z.string().nullable().optional(),
  alternatives: z.array(AltSchema).max(3).optional(),
});

const SYSTEM_RECOGNIZE = `你是中古杂货识别助手。看图后只输出 JSON，不要 markdown。
多张图时：第 1 张为主图（正面外观），其余为背面/包装/logo/型号/配件/尺寸等辅助角度，请综合判断，不要把广告词或场景文字误当商品名。
category 枚举（必须从中选）：jp_porcelain(日本瓷器) / eu_porcelain(欧洲瓷器) / vintage_toy(中古玩具) / anime_goods(二次元周边) / media(音像) / digital(数码家电) / jewelry(珠宝) / fashion(时尚配件) / daily(日用) / antique(古美术)。
name 用中文，格式「品牌/系列 + 具体物品 + 关键规格」，不超过 28 字。
condition_grade：N全新 / S近全新 / A良好 / B一般 / C较旧 / J有瑕疵。
era 用 1970s / 昭和后期 这种粒度，不知就 null。
suggested_price_cny 给整数 RMB 估值，没把握就 null。
confidence 是 0~1 数字，反映 name+category 的整体把握。
alternatives 最多 3 条备选（只填 name/category/confidence），若唯一确定可省略。
warning 用于低置信度或多张图信息矛盾时的一句提醒，一切正常就 null。
不知道的字段一律 null，不要瞎编。`;

function toDataUrl(input: { image_url?: string; image_base64?: string }): string {
  if (input.image_url) return input.image_url;
  const b64 = input.image_base64 || "";
  return b64.startsWith("data:") ? b64 : `data:image/jpeg;base64,${b64}`;
}

async function signStoragePaths(
  paths: Array<{ bucket: "sku-raw" | "sku-listing"; storage_path: string }>,
): Promise<string[]> {
  // 按 bucket 分组签名，24h 足够单次识别调用
  const byBucket = new Map<string, string[]>();
  paths.forEach((p) => {
    if (!byBucket.has(p.bucket)) byBucket.set(p.bucket, []);
    byBucket.get(p.bucket)!.push(p.storage_path);
  });
  const urlByPath = new Map<string, string>();
  for (const [bucket, list] of byBucket) {
    const { data, error } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUrls(list, 60 * 60);
    if (error) throw new Error(`sign ${bucket}: ${error.message}`);
    (data ?? []).forEach((r, idx) => {
      if (r?.signedUrl) urlByPath.set(list[idx], r.signedUrl);
    });
  }
  // 按输入顺序返回
  return paths
    .map((p) => urlByPath.get(p.storage_path))
    .filter((u): u is string => !!u);
}

export async function aiRecognizeItem(input: {
  image_url?: string;
  image_base64?: string;
  images?: Array<{ image_url?: string; image_base64?: string }>;
  image_urls?: string[];
  image_storage_paths?: Array<{ bucket: "sku-raw" | "sku-listing"; storage_path: string }>;
  primary_index?: number;
  hint?: string;
}) {
  // 收集所有图片来源，统一转成 { url } 数组，最多 6 张
  const sources: Array<{ image_url?: string; image_base64?: string }> = [];
  if (input.image_storage_paths && input.image_storage_paths.length > 0) {
    const signed = await signStoragePaths(input.image_storage_paths.slice(0, 6));
    signed.forEach((u) => sources.push({ image_url: u }));
  }
  if (input.image_urls && input.image_urls.length > 0) {
    input.image_urls.slice(0, 6).forEach((u) => sources.push({ image_url: u }));
  }
  if (input.images && input.images.length > 0) {
    sources.push(...input.images.slice(0, 6));
  }
  if (sources.length === 0 && (input.image_url || input.image_base64)) {
    sources.push({ image_url: input.image_url, image_base64: input.image_base64 });
  }
  if (sources.length === 0) throw new Error("no image provided");

  const capped = sources.slice(0, 6);
  // primary_index：把指定下标挪到第 0 位
  const primary = Math.min(Math.max(0, input.primary_index ?? 0), capped.length - 1);
  if (primary > 0) {
    const [main] = capped.splice(primary, 1);
    capped.unshift(main);
  }

  const imageParts = capped.map((s) => ({
    type: "image_url" as const,
    image_url: { url: toDataUrl(s) },
  }));

  const hintLine = input.hint ? `店员补充：${input.hint}\n` : "";
  const multiNote =
    capped.length > 1
      ? `共 ${capped.length} 张图，第 1 张是主图，其余为细节/不同角度，请综合判断。\n`
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
  const confidence = typeof out.confidence === "number" ? out.confidence : null;
  const lowConf = confidence !== null && confidence < 0.6;
  const warning =
    out.warning ??
    (lowConf ? "识别置信度较低，建议人工核对名称与分类" : null);
  return {
    name: out.name ?? "",
    category: out.category ?? null,
    brand: out.brand ?? null,
    era: out.era ?? null,
    condition_grade: out.condition_grade ?? null,
    description: out.description ?? null,
    suggested_price_cny: out.suggested_price_cny ?? null,
    confidence,
    warning,
    alternatives: out.alternatives ?? [],
    raw,
  };
}


const SYSTEM_LISTING_IMAGE = `把这张中古杂货实物图修整成上架主图：
- 输出必须是 1:1 正方形（1024x1024），主体居中裁切、四周留白均匀
- 背景统一为干净浅灰底
- 校正角度，修正白平衡和曝光
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
