import { createHmac, timingSafeEqual } from "node:crypto";
import sharp from "sharp";

const widths = [0, 480, 1600];
const buckets = ["sku-raw", "sku-listing", "transfer-receipts"];
const receiptPath = /^[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(jpg|png)$/i;
const validPath = (path: string) =>
  path.length < 1024 &&
  path.split("/").every((p) => !!p && p !== "." && p !== "..") &&
  !/[\\\u0000-\u001f]/.test(path);
const mac = (path: string, width: number, expires: number, secret: string) =>
  createHmac("sha256", secret).update(`transfer-photo:v1:${path}:${width}:${expires}`).digest();

// Mint only after the transfer service has authorized access to this receipt.
export function receiptPhotoURL(
  path: string,
  width: number,
  secret: string,
  origin: string,
  now = Date.now(),
) {
  if (!secret || !receiptPath.test(path) || ![480, 1600].includes(width))
    throw new Error("Invalid receipt grant");
  const expires = Math.floor(now / 1000) + 3600;
  const url = new URL("/api/public/handheld/transfer-photo", origin);
  url.search = new URLSearchParams({
    path,
    width: String(width),
    expires: String(expires),
    signature: mac(path, width, expires, secret).toString("hex"),
  }).toString();
  return url.href;
}

export function verifyReceiptPhotoURL(
  url: URL,
  secret: string,
  now = Date.now(),
): { path: string; width: number } | null {
  const path = url.searchParams.get("path") ?? "";
  const width = Number(url.searchParams.get("width"));
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature") ?? "";
  if (
    !secret ||
    !receiptPath.test(path) ||
    ![480, 1600].includes(width) ||
    !Number.isSafeInteger(expires) ||
    expires <= now / 1000 ||
    expires > now / 1000 + 3600 ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return null;
  return timingSafeEqual(Buffer.from(signature, "hex"), mac(path, width, expires, secret))
    ? { path, width }
    : null;
}

export function createImageReader(download: (bucket: string, path: string) => Promise<Buffer>) {
  const cache = new Map<string, { bytes: Buffer; until: number }>();
  const pending = new Map<string, Promise<Buffer>>();
  let cachedBytes = 0;
  return async (bucket: string, path: string, width: number): Promise<Buffer> => {
    if (!buckets.includes(bucket) || !validPath(path) || !widths.includes(width))
      throw new Error("Invalid image");
    const key = `${bucket}/${path}@${width}`;
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.bytes;
    if (hit) {
      cache.delete(key);
      cachedBytes -= hit.bytes.length;
    }
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    if (pending.size >= 16) throw new Error("Image service busy");
    const task = (async () => {
      const original = await download(bucket, path);
      if (!original.length || original.length > 12 * 1024 * 1024)
        throw new Error("Invalid image size");
      const image = sharp(original, { limitInputPixels: 40_000_000 }).rotate();
      const bytes = width
        ? await image
            .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: width === 480 ? 78 : 90 })
            .toBuffer()
        : original;
      while (cache.size && (cache.size >= 128 || cachedBytes + bytes.length > 64 * 1024 * 1024)) {
        const oldest = cache.keys().next().value!;
        cachedBytes -= cache.get(oldest)!.bytes.length;
        cache.delete(oldest);
      }
      cache.set(key, { bytes, until: Date.now() + 3600_000 });
      cachedBytes += bytes.length;
      return bytes;
    })();
    pending.set(key, task);
    try {
      return await task;
    } finally {
      pending.delete(key);
    }
  };
}

export const readERPImage = createImageReader(async (bucket, path) => {
  const origin = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!origin || !key) throw new Error("Image storage unavailable");
  const url = new URL(
    `storage/v1/object/authenticated/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`,
    `${origin.replace(/\/+$/, "")}/`,
  );
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, apikey: key },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.body) throw new Error("Image download failed");
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 12 * 1024 * 1024) throw new Error("Image too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
});
