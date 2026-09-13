/**
 * 消费者端（小程序）统一压缩衍生图契约 —— 纯逻辑部分（可单测，不依赖任何 client）。
 *
 * 规则：
 * - 只认「本项目已知存储地址」：bucket/path，或本项目 Supabase / 腾讯媒体域名下的
 *   /storage/v1/object|render/image/public|sign/<bucket>/<path>。
 * - 任意外域 URL、data:、未知桶、目录穿越一律 null（不代理、不开放私桶、不回退原图）。
 * - 衍生图宽度固定档位：thumbnail 480 / preview 960。
 */

export const DERIVATIVE_BUCKETS = [
  "sku-raw",
  "sku-listing",
  "parcel-item-images",
  "shop-images",
  "domestic-order-screenshots",
  "domestic-bulk-attachments",
] as const;
export type DerivativeBucket = (typeof DERIVATIVE_BUCKETS)[number];

/** 腾讯媒体侧当前只有这个公共桶，公共桶才能用 render/image/public 直出衍生图。 */
export const TENCENT_PUBLIC_BUCKETS = ["parcel-item-images"] as const;

export const DERIVATIVE_WIDTHS = { thumbnail: 480, preview: 960 } as const;
export const DERIVATIVE_QUALITY = 75;
export const DERIVATIVE_RESIZE = "contain" as const;

export type StorageRef = {
  origin: "primary" | "tencent";
  bucket: DerivativeBucket;
  path: string;
};

function isAllowedBucket(value: string): value is DerivativeBucket {
  return (DERIVATIVE_BUCKETS as readonly string[]).includes(value);
}

function splitBucketPath(raw: string): { bucket: string; path: string } | null {
  const clean = raw.replace(/^\/+/, "");
  const idx = clean.indexOf("/");
  if (idx <= 0) return null;
  const bucket = clean.slice(0, idx);
  const path = clean.slice(idx + 1);
  if (!path || path.includes("..")) return null;
  return { bucket, path };
}

const STORAGE_PREFIX =
  /^\/storage\/v1\/(?:object|render\/image)\/(?:public|sign)\/(?<rest>.+)$/;

function normalizeOrigin(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * 把任意图片值解析成安全的 { origin, bucket, path }；无法安全解析返回 null。
 * 不接受未知域名（防 SSRF / 外链代理）、data:、签名 token 之外的任意路径。
 */
export function parseStorageRef(
  value: string | null | undefined,
  origins: { primary?: string | null; tencent?: string | null } = {},
): StorageRef | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw.startsWith("data:")) return null;

  if (!/^https?:\/\//i.test(raw)) {
    const parsed = splitBucketPath(raw);
    if (!parsed || !isAllowedBucket(parsed.bucket)) return null;
    return { origin: "primary", bucket: parsed.bucket, path: decodeSegments(parsed.path) };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const primary = normalizeOrigin(origins.primary);
  const tencent = normalizeOrigin(origins.tencent);
  const origin: StorageRef["origin"] | null =
    primary && url.origin === primary ? "primary" : tencent && url.origin === tencent ? "tencent" : null;
  if (!origin) return null;

  const match = STORAGE_PREFIX.exec(url.pathname);
  if (!match?.groups?.["rest"]) return null;
  const parsed = splitBucketPath(match.groups["rest"]);
  if (!parsed || !isAllowedBucket(parsed.bucket)) return null;
  const path = decodeSegments(parsed.path);
  if (!path || path.includes("..")) return null;
  return { origin, bucket: parsed.bucket, path };
}

function decodeSegments(path: string): string {
  return path
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join("/");
}

function encodeSegments(path: string): string {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/**
 * 腾讯媒体衍生图精确契约（公共桶，无需密钥）：
 * {origin}/storage/v1/render/image/public/{bucket}/{encoded path}?width=W&quality=75&resize=contain
 * 私有桶 / 非腾讯 ref 返回 null。
 */
export function buildTencentDerivativeUrl(
  ref: StorageRef,
  width: number,
  origin: string | null | undefined,
): string | null {
  const base = origin?.trim().replace(/\/+$/, "");
  if (!base || ref.origin !== "tencent") return null;
  if (!(TENCENT_PUBLIC_BUCKETS as readonly string[]).includes(ref.bucket)) return null;
  return `${base}/storage/v1/render/image/public/${ref.bucket}/${encodeSegments(ref.path)}?width=${width}&quality=${DERIVATIVE_QUALITY}&resize=${DERIVATIVE_RESIZE}`;
}
