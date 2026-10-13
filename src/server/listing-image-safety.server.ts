import sharp from "sharp";
import { beforeAiOutbound, type AiOutboundGuard } from "./ai-guard.ts";
import { listingAiFetch } from "./listing-ai-transport.server.ts";

export function requiresOriginalMeasurementPixels(value: unknown): boolean {
  if (!value || typeof value !== "object") throw new Error("Measurement detection result unavailable; retry required");
  const result = value as { measurement_tool?: unknown; confidence?: unknown };
  if (typeof result.measurement_tool !== "boolean" || typeof result.confidence !== "number" ||
    !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
    throw new Error("Measurement detection result invalid; retry required");
  }
  if (result.measurement_tool) return true;
  if (result.confidence < 0.95) return true;
  return false;
}

export async function squareOriginalImage(bytes: Buffer): Promise<{ b64: string; mime: string }> {
  // Only orient and pad. Never regenerate ruler ticks or upscale the photographed object.
  const { data, info } = await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().png().toBuffer({ resolveWithObject: true });
  const side = Math.max(info.width, info.height);
  const horizontal = side - info.width;
  const vertical = side - info.height;
  const padded = await sharp(data).extend({ left: Math.floor(horizontal / 2), right: Math.ceil(horizontal / 2),
    top: Math.floor(vertical / 2), bottom: Math.ceil(vertical / 2), background: "#f4f4f4" }).png().toBuffer();
  return { b64: padded.toString("base64"), mime: "image/png" };
}

/** Per-photo end-to-end budget (download, detection, generation, validation share one signal). */
export const LISTING_IMAGE_BUDGET_MS = 120_000;
export const DETECTION_TIMEOUT_MS = 12_000;
export const GENERATION_TIMEOUT_MS = 40_000;
export const FALLBACK_GENERATION_TIMEOUT_MS = 60_000;
export const VALIDATION_TIMEOUT_MS = 20_000;
/** Analysis work copy long edge; generation keeps the full original input. */
export const ANALYSIS_LONG_EDGE = 1024;

/** Detection fallback: uncertain photos are retouched under ruler + close-up protection, never shipped as-is. */
export const CONSERVATIVE_PROFILE: ListingImageProfile = Object.freeze({ measurementTool: true, closeUp: true });

/** Stage deadline that never outlives the shared per-photo budget. */
export function stageSignal(ms: number, budget?: AbortSignal): AbortSignal {
  const own = AbortSignal.timeout(ms);
  return budget ? AbortSignal.any([own, budget]) : own;
}

/** Errors that must not be retried (auth/denial). Persisted as `permanent: ...` so the DB fails the job at once. */
export class PermanentImageError extends Error {
  constructor(message: string) { super(`permanent: ${message}`); this.name = "PermanentImageError"; }
}

/** Downscaled JPEG data URL for detection/validation only; the original pixels are never altered. */
export async function analysisCopy(dataUrl: string): Promise<string> {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:image/") || comma < 0) return dataUrl;
  try {
    const bytes = Buffer.from(dataUrl.slice(comma + 1), "base64");
    const out = await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate()
      .resize({ width: ANALYSIS_LONG_EDGE, height: ANALYSIS_LONG_EDGE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  } catch {
    return dataUrl;
  }
}

export async function loadOriginalImage(image: string, budget?: AbortSignal): Promise<Buffer> {
  if (image.startsWith("data:image/")) {
    const comma = image.indexOf(",");
    const bytes = Buffer.from(image.slice(comma + 1), "base64");
    if (!bytes.length || bytes.length > 20_000_000) throw new Error("Image too large or empty");
    return bytes;
  }
  const url = new URL(image);
  const allowed = [process.env.SUPABASE_URL, process.env.TENCENT_MEDIA_URL].filter(Boolean)
    .map((value) => new URL(value!).origin);
  if (url.protocol !== "https:" || !allowed.includes(url.origin) || !url.pathname.startsWith("/storage/v1/")) {
    throw new Error("Original image must use trusted storage");
  }
  const response = await fetch(url, { signal: stageSignal(15_000, budget), redirect: "error" });
  if (!response.ok || !response.body) throw new Error("Original image unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > 20_000_000) throw new Error("Image too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export type ListingImageProfile = { measurementTool: boolean; closeUp: boolean };

export function parseListingImageProfile(value: unknown): ListingImageProfile {
  const result = value as { measurement_tool?: unknown; close_up?: unknown; confidence?: unknown } | null;
  if (!result || typeof result.measurement_tool !== "boolean" || typeof result.close_up !== "boolean") {
    throw new Error("Measurement/detail image classification invalid; retry required");
  }
  requiresOriginalMeasurementPixels({ measurement_tool: result.measurement_tool || result.close_up, confidence: result.confidence });
  // Uncertainty tightens framing and output review instead of stalling retouching.
  const uncertain = (result.confidence as number) < 0.95;
  return { measurementTool: result.measurement_tool || uncertain, closeUp: result.close_up || uncertain };
}

export const MEASUREMENT_DETECTION_PROMPT = '判断图中是否有放在商品旁边、用于测量商品尺寸的外部独立测量工具：尺子、卷尺、卡尺、测量垫。' +
  '以下属于商品本身，不算测量工具：唱臂及其刻度、收音机频率表/调谐刻度、旋钮或仪表刻度、钟表盘、装饰网格或格纹、印刷的型号/年份/文字。' +
  '同时判断是否为特写细节图：主体局部、底款、文字、年份、纹理、瑕疵或大部分画面被细节占满而非完整商品全景。' +
  '仅返回 JSON {"measurement_tool":true/false,"close_up":true/false,"confidence":0至1}。看到外部测量工具但不确定是否用于测量时返回 measurement_tool=true；特写不确定时返回 close_up=true，避免改变细节角度。';

/** Marks the failing stage without changing the error type (TimeoutError stays TimeoutError) or adding sensitive text. */
export function withImageStage<T>(stage: "measurement_detection" | "image_generation" | "image_validation", run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    if (error && typeof error === "object") {
      try { Object.defineProperty(error, "stage", { value: stage, enumerable: true, configurable: true }); } catch { /* frozen */ }
      throw error;
    }
    throw Object.assign(new Error(`${stage} failed`), { stage });
  });
}

/** Persistable job error: stage prefix + sanitized message, no URLs/data payloads. */
export function safeImageJobError(error: unknown): string {
  const stage = error && typeof error === "object" && typeof (error as { stage?: unknown }).stage === "string"
    && /^[a-z_]{1,40}$/.test((error as { stage: string }).stage) ? (error as { stage: string }).stage : null;
  const name = error instanceof Error && error.name && error.name !== "Error" ? `${error.name}: ` : "";
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw
    .replace(/data:[^\s,]*,[A-Za-z0-9+/=]+/g, "[data]")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/[?&](token|sig|signature|X-Amz-[A-Za-z]+)=\S+/gi, "[redacted]");
  if (message.startsWith("permanent: ")) return `permanent: ${stage ? `[${stage}] ` : ""}${message.slice(11)}`.slice(0, 1000);
  return `${stage ? `[${stage}] ` : ""}${name}${message}`.slice(0, 1000);
}

export async function classifyListingImage(image: string, key: string, guard: AiOutboundGuard, budget?: AbortSignal): Promise<ListingImageProfile> {
  return withImageStage("measurement_detection", () => detectMeasurement(image, key, guard, budget));
}

async function detectMeasurement(image: string, key: string, guard: AiOutboundGuard, budget?: AbortSignal): Promise<ListingImageProfile> {
  // Consent/guard failures propagate (fail closed); only detector uncertainty falls back to protection.
  await beforeAiOutbound(guard, "measurement_detection");
  let response: Response;
  try {
    response = await listingAiFetch(JSON.stringify({ model: "google/gemini-2.5-flash", max_tokens: 512, reasoning: { max_tokens: 0 },
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: [
          { type: "text", text: MEASUREMENT_DETECTION_PROMPT },
          { type: "image_url", image_url: { url: image } },
        ] }],
      }), key, stageSignal(DETECTION_TIMEOUT_MS, budget));
  } catch (error) {
    // The shared budget expiring is a real failure, not detector uncertainty.
    if (budget?.aborted) throw error;
    if (error instanceof TypeError || (error as { name?: string })?.name === "TimeoutError") return CONSERVATIVE_PROFILE;
    throw error;
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new PermanentImageError(`Measurement detection HTTP ${response.status}`);
  }
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    return CONSERVATIVE_PROFILE;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Measurement detection HTTP ${response.status}; retry required`);
  }
  try {
    const payload = await response.json();
    if (payload.choices?.[0]?.finish_reason === "length") return CONSERVATIVE_PROFILE;
    return parseListingImageProfile(JSON.parse(payload.choices?.[0]?.message?.content ?? "{}"));
  } catch (error) {
    if (budget?.aborted) throw error;
    return CONSERVATIVE_PROFILE;
  }
}

export async function validatePreparedListingImage(source: string, output: string, key: string, profile: ListingImageProfile, guard: AiOutboundGuard, budget?: AbortSignal): Promise<void> {
  return withImageStage("image_validation", async () => {
    await beforeAiOutbound(guard, "image_validation");
    // Compare reduced analysis copies; the shipped output is not altered.
    [source, output] = await Promise.all([analysisCopy(source), analysisCopy(output)]);
    const response = await listingAiFetch(JSON.stringify({ model: "google/gemini-2.5-flash", max_tokens: 1024, reasoning: { max_tokens: 0 },
        response_format: { type: "json_object" }, messages: [{ role: "user", content: [
          { type: "text", text: '第一张为原图，第二张为修图成品。逐项对比，不确定即返回 false。' +
            'hands_removed：成品不得出现真实人物手指、手掌、手臂和投影；不要把商品玩偶肢体或印刷人物当真人手。' +
            'product_present：成品中必须清晰可见完整的商品本体，不能是空背景、纯灰图或只剩阴影/袋子轮廓；原图袋中商品在成品中必须仍然存在。' +
            `product_scale：${profile.measurementTool || profile.closeUp ? '本图为测量/特写保护图，只补边成正方形，商品（含测量工具）在画面中的比例不得比原图缩小，且主体长边至少占画面一半。' : '商品主体居中，主体长边约占画面70%-85%，至少占画面一半，不能是缩在中间的小主体。'}` +
            'product_preserved：商品本体必须完整可见、未被删掉或截断；清除外层透明袋时不得删掉袋中商品；商品本身及包装的可见文字、商标、印刷图案、生产标记、颜色、配件数量、真实瑕疵和形状未被改造，未凭空添加被手遮住的文字或细节；清除外贴售价牌/价签、平台水印以及外层透明包装袋属于允许操作，不算违规；但若商品本身是透明袋/透明材质被删掉则判 false。' +
            'outer_bag_removed：成品不得残留商品外层的透明包装袋（OPP袋、自封袋、塑料外袋）及其袋边、封口、褶皱或反光；原图没有外层透明袋则填 true；商品本身为透明袋/透明材质时不算外袋。' +
            'external_labels_removed：成品不得残留任何外部附加的售价贴纸、价格牌、价签（包括贴在透明包装、挂卡、包装纸板上的，如“¥12.9 BOOMER”），也不得残留平台水印或叠字；原图没有这些则填 true。' +
            'gray_background：非商品区域是干净浅灰背景，无原桌面、人物残留（本项不代替 external_labels_removed）。' +
            `measurement_preserved：${profile.measurementTool ? '若原图有外部测量工具（尺子等），成品中必须完整保留且可读，刻度、数字、单位和与商品的测量位置关系与原图相同，未重绘或臆造；若原图没有外部测量工具则填 true，不能要求成品添加尺子。' : '本图无外部测量工具，填 true。'}` +
            `detail_preserved：${profile.closeUp ? '特写角度、透视和原有细节构图未改变，未裁掉细节，只补边成正方形。' : '非特写图，填 true。'}` +
            '仅返回 JSON {"product_present":bool,"product_scale":bool,"hands_removed":bool,"product_preserved":bool,"gray_background":bool,"measurement_preserved":bool,"detail_preserved":bool,"external_labels_removed":bool,"outer_bag_removed":bool,"confidence":0至1}。' },
          { type: "image_url", image_url: { url: source } },
          { type: "image_url", image_url: { url: output } },
        ] }] }), key, stageSignal(VALIDATION_TIMEOUT_MS, budget));
    if (response.status === 401 || response.status === 403) throw new PermanentImageError(`Image validation HTTP ${response.status}`);
    if (!response.ok) throw new Error(`Image validation HTTP ${response.status}; original retained, retry required`);
    const payload = await response.json();
    if (payload.choices?.[0]?.finish_reason === "length") throw new Error("Image validation truncated; original retained");
    const result = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}");
    const failedFields = VALIDATION_FIELDS.filter(field => result?.[field] !== true);
    const confidenceOk = typeof result?.confidence === "number" && Number.isFinite(result.confidence)
      && result.confidence >= 0.95 && result.confidence <= 1;
    if (!confidenceOk || failedFields.length) throw new Error(validationFailureMessage(failedFields, result?.confidence));
  });
}

export const VALIDATION_FIELDS = ["product_present", "product_scale", "hands_removed", "product_preserved", "gray_background", "measurement_preserved",
  "detail_preserved", "external_labels_removed", "outer_bag_removed"] as const;

/** Safe failure text: only fixed field names and a numeric confidence, never model text, images or URLs. */
/** Fields reportable in safe failure text: model checks plus the pixel-only canvas check. */
export const REPORTABLE_FIELDS = [...VALIDATION_FIELDS, "canvas_square"] as const;
type ReportableField = (typeof REPORTABLE_FIELDS)[number];

export function validationFailureMessage(failedFields: readonly string[], confidence: unknown): string {
  const fields = failedFields.filter((f): f is string => (REPORTABLE_FIELDS as readonly string[]).includes(f));
  const conf = typeof confidence === "number" && Number.isFinite(confidence) ? confidence.toFixed(2) : "invalid";
  return `修图检查未通过（fields=${fields.join(",") || "none"}; confidence=${conf}），原图保留，请重修`;
}

/** Fixed retry hints per known failed field. Only whitelisted field names from last_error are read. */
const RETRY_HINTS: Record<ReportableField, string> = {
  product_present: "上次成品里商品本体消失、只剩背景，本次必须完整保留画面中（含袋中）的商品本体，只换背景，绝不输出空背景。",
  product_scale: "上次商品主体过小，本次商品主体居中且长边占画面70%-85%，不得缩小商品。",
  canvas_square: "上次成品不是合适尺寸的正方形，本次必须输出1024x1024的1:1正方形。",
  hands_removed: "上次修图仍残留真人手指/手掌/手臂或投影，本次必须彻底去除真人手部。",
  product_preserved: "上次修图改动了商品实物，本次不得改动商品本体的文字、商标、颜色、形状、配件和真实瑕疵。",
  gray_background: "上次背景不干净，本次背景必须是干净浅灰底，去除桌面和杂物。",
  measurement_preserved: "上次尺子刻度或位置被改动，本次尺子刻度、数字和位置必须与原图完全一致。",
  detail_preserved: "上次特写角度或构图被改动，本次只轻修曝光，不改角度和构图。",
  external_labels_removed: "上次仍残留外贴价签或平台水印，本次必须彻底去除外贴价签、价格牌和水印。",
  outer_bag_removed: "上次仍残留外层透明包装袋，本次必须彻底去除外层透明袋及袋边、封口、褶皱和反光（商品本身为透明材质时保留）。",
};

export function retryInstructionFromError(lastError: unknown): string | undefined {
  if (typeof lastError !== "string") return undefined;
  const m = lastError.match(/fields=([a-z_,]{1,200})/);
  if (!m) return undefined;
  const known = [...new Set(m[1].split(","))].filter((f): f is ReportableField =>
    (REPORTABLE_FIELDS as readonly string[]).includes(f));
  return known.length ? known.map(f => RETRY_HINTS[f]).join("") : undefined;
}

/** Pixel gate thresholds (real pixels, independent of any model JSON). */
export const PIXEL_MIN_SIDE = 1000;
export const PIXEL_MAX_SIDE = 2048;
export const MIN_SUBJECT_LONG_EDGE = 0.5;
const GRID = 256;
const CORNER = 8;
const FG_DELTA = 20;
const MIN_FG_FRACTION = 0.02;
const LINE_MIN_PIXELS = 3;

/**
 * Real-pixel defence before model validation: the output must be a properly sized 1:1 canvas with a
 * consistent light corner background, a non-empty foreground, and a subject bounding box whose long edge
 * covers at least half the canvas. Model JSON alone can never pass a blank/gray or tiny-subject image.
 */
export async function assertListingImagePixels(b64: string): Promise<void> {
  return withImageStage("image_validation", async () => {
    const fail = (fields: string[]): never => { throw new Error(validationFailureMessage(fields, undefined)); };
    let width = 0, height = 0, raw: Buffer;
    try {
      const input = sharp(Buffer.from(b64, "base64"), { limitInputPixels: 40_000_000 });
      const meta = await input.metadata();
      width = meta.width ?? 0; height = meta.height ?? 0;
      raw = await input.flatten({ background: "#ffffff" }).resize(GRID, GRID, { fit: "fill" }).removeAlpha().raw().toBuffer();
    } catch {
      return fail(["product_present"]);
    }
    if (width !== height || width < PIXEL_MIN_SIDE || width > PIXEL_MAX_SIDE) fail(["canvas_square"]);
    const px = (x: number, y: number) => { const i = (y * GRID + x) * 3; return [raw[i], raw[i + 1], raw[i + 2]]; };
    const cornerMean = (x0: number, y0: number) => {
      const sum = [0, 0, 0];
      for (let y = y0; y < y0 + CORNER; y++) for (let x = x0; x < x0 + CORNER; x++) px(x, y).forEach((v, c) => { sum[c] += v; });
      return sum.map(v => v / (CORNER * CORNER));
    };
    const corners = [cornerMean(0, 0), cornerMean(GRID - CORNER, 0), cornerMean(0, GRID - CORNER), cornerMean(GRID - CORNER, GRID - CORNER)];
    const bg = [0, 1, 2].map(c => corners.reduce((a, k) => a + k[c], 0) / 4);
    const cornersConsistent = corners.every(k => k.every((v, c) => Math.abs(v - bg[c]) <= 24));
    const lightGray = Math.min(...bg) >= 170 && Math.max(...bg) - Math.min(...bg) <= 30;
    if (!cornersConsistent || !lightGray) fail(["gray_background"]);
    const rows = new Array<number>(GRID).fill(0), cols = new Array<number>(GRID).fill(0);
    let fg = 0;
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      const p = px(x, y);
      if (Math.max(Math.abs(p[0] - bg[0]), Math.abs(p[1] - bg[1]), Math.abs(p[2] - bg[2])) > FG_DELTA) { fg++; rows[y]++; cols[x]++; }
    }
    if (fg / (GRID * GRID) < MIN_FG_FRACTION) fail(["product_present"]);
    const span = (counts: number[]) => {
      const first = counts.findIndex(n => n >= LINE_MIN_PIXELS);
      if (first < 0) return 0;
      let last = first;
      counts.forEach((n, i) => { if (n >= LINE_MIN_PIXELS) last = i; });
      return last - first + 1;
    };
    const longEdge = Math.max(span(rows), span(cols)) / GRID;
    if (longEdge === 0) fail(["product_present"]);
    if (longEdge < MIN_SUBJECT_LONG_EDGE) fail(["product_scale"]);
  });
}
