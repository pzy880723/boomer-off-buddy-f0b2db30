import sharp from "sharp";

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

export async function loadOriginalImage(image: string): Promise<Buffer> {
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
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error" });
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
  return `${stage ? `[${stage}] ` : ""}${name}${message}`.slice(0, 1000);
}

export async function classifyListingImage(image: string, key: string): Promise<ListingImageProfile> {
  return withImageStage("measurement_detection", () => detectMeasurement(image, key));
}

async function detectMeasurement(image: string, key: string): Promise<ListingImageProfile> {
  // Upstream latency varies; background detection does not block the listing UI.
  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "google/gemini-2.5-flash", max_tokens: 512, response_format: { type: "json_object" },
      messages: [{ role: "user", content: [
        { type: "text", text: MEASUREMENT_DETECTION_PROMPT },
        { type: "image_url", image_url: { url: image } },
      ] }],
    }),
  });
  if (!response.ok) throw new Error(`Measurement detection HTTP ${response.status}; retry required`);
  const payload = await response.json();
  if (payload.choices?.[0]?.finish_reason === "length") throw new Error("Measurement classification truncated; retry required");
  return parseListingImageProfile(JSON.parse(payload.choices?.[0]?.message?.content ?? "{}"));
}

export async function validatePreparedListingImage(source: string, output: string, key: string, profile: ListingImageProfile): Promise<void> {
  return withImageStage("image_validation", async () => {
    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(45_000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-2.5-flash", max_tokens: 1024, reasoning: { max_tokens: 0 },
        response_format: { type: "json_object" }, messages: [{ role: "user", content: [
          { type: "text", text: '第一张为原图，第二张为修图成品。逐项对比，不确定即返回 false。' +
            'hands_removed：成品不得出现真实人物手指、手掌、手臂和投影；不要把商品玩偶肢体或印刷人物当真人手。' +
            'product_preserved：商品可见文字、商标、颜色、配件数量、真实瑕疵和形状未被改造，未凭空添加被手遮住的文字或细节。' +
            'gray_background：非商品区域是干净浅灰背景，无原桌面、人物、水印或价格标签残留。' +
            `measurement_preserved：${profile.measurementTool ? '尺子完整保留且可读，刻度、数字、单位和与商品的测量位置关系与原图相同，未重绘或臆造。' : '本图无外部测量工具，填 true。'}` +
            `detail_preserved：${profile.closeUp ? '特写角度、透视和原有细节构图未改变，未裁掉细节，只补边成正方形。' : '非特写图，填 true。'}` +
            '仅返回 JSON {"hands_removed":bool,"product_preserved":bool,"gray_background":bool,"measurement_preserved":bool,"detail_preserved":bool,"confidence":0至1}。' },
          { type: "image_url", image_url: { url: source } },
          { type: "image_url", image_url: { url: output } },
        ] }] }),
    });
    if (!response.ok) throw new Error(`Image validation HTTP ${response.status}; original retained, retry required`);
    const payload = await response.json();
    if (payload.choices?.[0]?.finish_reason === "length") throw new Error("Image validation truncated; original retained");
    const result = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}");
    const required = ["hands_removed", "product_preserved", "gray_background", "measurement_preserved", "detail_preserved"];
    if (typeof result.confidence !== "number" || !Number.isFinite(result.confidence) || result.confidence < 0.95 || result.confidence > 1
      || required.some(field => result[field] !== true)) {
      throw new Error("修图检查未通过：手部、背景或实物细节不符合要求，原图保留，请重修");
    }
  });
}
