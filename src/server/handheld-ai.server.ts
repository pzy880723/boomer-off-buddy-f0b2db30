// Server-only AI helpers for handheld smart-create flow.
// 识别共用 ERP 动态分类核心；gemini-3.1-flash-image 仅负责上架图修整。
// 走 Lovable AI Gateway，无需单独 key。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { recognizeProductFromImages } from "@/server/product-recognition.server";

const GATEWAY = "https://ai.gateway.lovable.dev/v1";

function getKey(): string {
  const k = process.env.LOVABLE_API_KEY;
  if (!k) throw new Error("LOVABLE_API_KEY not configured");
  return k;
}

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
  return paths.map((p) => urlByPath.get(p.storage_path)).filter((u): u is string => !!u);
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

  const out = await recognizeProductFromImages({
    images: capped.map(toDataUrl),
    source: "handheld",
    hint: input.hint,
  });
  return {
    ...out,
    // 兼容旧版手持 App；新版应读取 category_code / attributes。
    category: out.category_code,
    brand: out.attributes.brand,
    era: out.attributes.era,
    facet_codes: out.facets.map((facet) => facet.code),
    tags: out.facets.map((facet) => facet.name),
    alternatives: out.alternative_categories.map((item) => ({
      name: item.reason ?? item.category_code,
      category: item.category_code,
      confidence: item.confidence,
    })),
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
              SYSTEM_LISTING_IMAGE + (input.instruction ? `\n额外要求：${input.instruction}` : ""),
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
