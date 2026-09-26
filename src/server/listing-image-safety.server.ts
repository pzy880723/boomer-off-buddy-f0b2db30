import sharp from "sharp";

export function requiresOriginalMeasurementPixels(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  const result = value as { measurement_tool?: unknown; confidence?: unknown };
  return result.measurement_tool !== false || typeof result.confidence !== "number" ||
    !Number.isFinite(result.confidence) || result.confidence < 0.95 || result.confidence > 1;
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

export async function measurementProtectionRequired(image: string, key: string): Promise<boolean> {
  try {
    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(12_000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-2.5-flash", max_tokens: 128, response_format: { type: "json_object" },
        messages: [{ role: "user", content: [
          { type: "text", text: '图中是否有用于测量商品的尺子、卷尺、卡尺、网格测量垫或带尺寸刻度的工具？仅返回 JSON {"measurement_tool":true/false,"confidence":0至1}。不确定时返回 true。' },
          { type: "image_url", image_url: { url: image } },
        ] }],
      }),
    });
    if (!response.ok) return true;
    const payload = await response.json();
    return requiresOriginalMeasurementPixels(JSON.parse(payload.choices?.[0]?.message?.content ?? "{}"));
  } catch { return true; }
}
