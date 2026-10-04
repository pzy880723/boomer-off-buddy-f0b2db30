import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const MAX_BYTES = 12 * 1024 * 1024;
const TTL_MS = 30 * 60 * 1000;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(`handheld-upload-v1:${payload}`).digest();
}

function storageTarget(value: string, storageOrigin: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== new URL(storageOrigin).origin ||
      url.username || url.password || url.hash ||
      !/^\/storage\/v1\/object\/upload\/sign\/sku-(raw|listing)\/[0-9]{4}-[0-9]{2}-[0-9]{2}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{1,6}$/i.test(url.pathname) ||
      !url.searchParams.get("token")) throw new Error("Invalid storage target");
  return url;
}

export function createUploadRelayGrant(
  signedURL: string, contentType: string, secret: string, storageOrigin: string, now = Date.now(),
) {
  if (!secret || !ALLOWED_TYPES.has(contentType)) throw new Error("Invalid upload configuration");
  storageTarget(signedURL, storageOrigin);
  const payload = Buffer.from(JSON.stringify({ url: signedURL, contentType, expires: now + TTL_MS })).toString("base64url");
  // The capability lives in a header, never in ERP access-log URLs.
  return `${payload}.${signature(payload, secret).toString("base64url")}`;
}

export async function relayImageUpload(request: Request, options: {
  secret: string;
  storageOrigin: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  now?: number;
}) {
  const requestID = randomUUID();
  const started = Date.now();
  const response = (status: number, error?: string) => {
    // Do not log the capability, photo, original filename, or upstream response body.
    console.info(JSON.stringify({ event: "handheld_image_upload", request_id: requestID, status, elapsed_ms: Date.now() - started }));
    return Response.json({ ok: status === 200, ...(error ? { error } : {}), request_id: requestID }, {
      status, headers: { ...options.headers, "Cache-Control": "no-store" },
    });
  };
  let grant: { url: string; contentType: string; expires: number };
  try {
    const token = request.headers.get("x-upload-token") || "";
    const [payload, mac, extra] = token.split(".");
    if (!options.secret || token.length > 8192 || !payload || !mac || extra) throw new Error();
    const expected = signature(payload, options.secret);
    const supplied = Buffer.from(mac, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
    grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!Number.isFinite(grant.expires) || grant.expires <= (options.now ?? Date.now()) ||
        !ALLOWED_TYPES.has(grant.contentType)) throw new Error();
    storageTarget(grant.url, options.storageOrigin);
  } catch { return response(403, "图片上传凭证失效，请重试原图备份"); }

  const length = Number(request.headers.get("content-length"));
  if (length > MAX_BYTES) return response(413, "图片超过 12 MB，请缩小后重试");
  if (!request.body) return response(400, "图片为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return response(413, "图片超过 12 MB，请缩小后重试");
      }
      chunks.push(value);
    }
    if (!size) return response(400, "图片为空");
    const upstream = await (options.fetch ?? fetch)(grant.url, {
      method: "PUT", body: Buffer.concat(chunks), redirect: "error",
      headers: { "Content-Type": grant.contentType, "x-upsert": "false" },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(25000)]),
    });
    await upstream.body?.cancel();
    if (!upstream.ok) return response(upstream.status >= 500 ? 502 : upstream.status, "图片存储未完成，请重试原图备份");
    return response(200);
  } catch {
    return response(request.signal.aborted ? 499 : 504, "图片上传连接中断或超时，照片已保留，请重试原图备份");
  } finally { reader.releaseLock(); }
}
