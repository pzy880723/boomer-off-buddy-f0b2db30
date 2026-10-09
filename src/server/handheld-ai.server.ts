// Server-only AI helpers for handheld smart-create flow.
// 识别共用 ERP 动态分类核心；gemini-3.1-flash-image 仅负责上架图修整。
// 走 Lovable AI Gateway，无需单独 key。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { recognizeProductFromImages } from "@/server/product-recognition.server";
import sharp from "sharp";
import { beforeHandheldAiOutbound, type AiOutboundGuard } from "./ai-guard.ts";
import { loadOriginalImage, classifyListingImage, validatePreparedListingImage, withImageStage } from "./listing-image-safety.server";

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
}, guard: AiOutboundGuard) {
  await beforeHandheldAiOutbound(guard, "recognition_entry");
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
    aiGuard: guard,
    images: capped.map(toDataUrl),
    source: "handheld",
    hint: input.hint,
  });
  return {
    ...out,
    // 兼容旧版手持 App；新版应读取 category_code / attributes。
    category: out.category_code,
    brand: out.attributes.brand,
    ip_name: out.ip_name,
    ip_match_status: out.ip_match_status,
    ip_suggestions: out.ip_suggestions,
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
- 清除照片平台叠加的闲鱼等平台账号水印、平台标识叠字，以及商品外部附加的售价贴纸、价格牌；保留商品本身的商标、印刷文字和真实瑕疵；不得删除商品本体印刷、型号、生产标记或真实瑕疵
- 手持拍摄时，清除所有真实人物的手指、手掌、手臂及其投影，不得留在成品中；不要删除商品本身的人物造型、玩偶肢体或印刷图案。仅清理可见手部，不得凭空补造被遮挡的商品细节、文字或尺子刻度
- 测量图仍须换浅灰背景；尺子、卷尺、尺寸刻度和数字必须完整保留，不得重绘、移动或修改，保持与商品的测量位置关系
- 特写细节图只轻微修饰曝光与白平衡，保留拍摄角度、透视和细节构图；不得重新摆正或裁掉细节，以补边方式形成正方形
- 严禁添加任何文字、水印、贴纸`;

function sniffImageMime(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(4, 12).toString("ascii").startsWith("ftyphei")) return "image/heic";
  throw new Error("Unsupported original image format");
}

/** Returns base64 PNG (no data: prefix). */
export async function aiPrepareListingImage(input: {
  image_url?: string;
  image_base64?: string;
  instruction?: string;
}, guard: AiOutboundGuard): Promise<{ b64: string; mime: string; preserved_original?: true }> {
  // Handheld-only: a web guard is never accepted; every AI stage re-checks the original actor.
  await beforeHandheldAiOutbound(guard, "load_original");
  // Download the trusted original once and share the same inline bytes with detection and generation,
  // so the gateway never fetches signed URLs itself.
  let source = await loadOriginalImage(input.image_url
    ? input.image_url
    : input.image_base64?.startsWith("data:")
      ? input.image_base64
      : `data:image/jpeg;base64,${input.image_base64 ?? ""}`);
  const metadata = await sharp(source, { limitInputPixels: 40_000_000 }).metadata();
  if (metadata.orientation && metadata.orientation !== 1) source = await sharp(source).rotate().png().toBuffer();
  const dataUrl = `data:${sniffImageMime(source)};base64,${source.toString("base64")}`;

  const profile = await classifyListingImage(dataUrl, getKey(), guard);
  const protectedImage = profile.measurementTool || profile.closeUp;
  const prompt = protectedImage ? SYSTEM_LISTING_IMAGE
    .replace("主体居中裁切、四周留白均匀", "只补边形成正方形，不裁掉商品细节或测量工具")
    .replace("校正角度，修正白平衡和曝光", "禁止校正角度、旋转、改变透视或重新摆放商品与尺子，只轻微修正白平衡和曝光")
    : SYSTEM_LISTING_IMAGE;

  const body = {
    model: "google/gemini-3.1-flash-image",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              (input.instruction ? `额外要求（不得违反下列实物保护规则）：${input.instruction}\n` : "") + prompt,
          },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    modalities: ["image", "text"],
  };

  const output = await withImageStage("image_generation", () => generateListingImage(body, guard));
  await validatePreparedListingImage(dataUrl, `data:${output.mime};base64,${output.b64}`, getKey(), profile, guard);
  return output;
}

/** Safe diagnostic for a 200 response without image; never echoes model content. */
export function missingImageError(finishReason: unknown): string {
  const reason = typeof finishReason === "string" && /^[a-z_]{1,40}$/.test(finishReason) ? finishReason : "unknown";
  return `图像生成服务未返回图片（${reason}），原图保留`;
}

async function generateListingImage(body: unknown, guard: AiOutboundGuard): Promise<{ b64: string; mime: string }> {
  await beforeHandheldAiOutbound(guard, "image_generation");
  const res = await fetch(`${GATEWAY}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: {
      Authorization: `Bearer ${getKey()}`,
      "Content-Type": "application/json",
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    // Upstream text may echo signed URLs or image payloads; only the status is reported.
    throw new Error(`AI gateway ${res.status}`);
  }
  const j = await res.json();
  // OpenRouter image response shape: choices[0].message.images[0].image_url.url (data: URL)
  const url: string | undefined =
    j?.choices?.[0]?.message?.images?.[0]?.image_url?.url ??
    j?.choices?.[0]?.message?.content?.[0]?.image_url?.url;
  if (!url || !url.startsWith("data:")) {
    throw new Error(missingImageError(j?.choices?.[0]?.finish_reason));
  }
  const m = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("Unsupported image data URL");
  return { mime: m[1], b64: m[2] };
}
