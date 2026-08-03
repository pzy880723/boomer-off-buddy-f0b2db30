/**
 * SKU 图片对外可取地址工具（纯函数，可测试）。
 *
 * 背景：inv_skus.image_paths 里保存的是私有桶路径（例如 `sku-listing/2026/xx.jpg`），
 * 不是 http URL。之前把这些路径直接丢给有赞素材上传接口，导致 [160400100] file 参数错误。
 * 正确做法：先转成 ERP 的公开只读代理地址 /api/public/media/sku/<bucket>/<path>，
 * 有赞侧（素材库或建品 picture）才能真正抓取到图片。
 */

export const SKU_MEDIA_BUCKETS = ["sku-raw", "sku-listing"] as const;
export type SkuMediaBucket = (typeof SKU_MEDIA_BUCKETS)[number];

export const PUBLIC_SKU_MEDIA_PREFIX = "/api/public/media/sku";

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** 把 `sku-listing/a/b.jpg` 解析成 { bucket, path }；非法或未知桶返回 null。 */
export function parseSkuMediaPath(value: string): { bucket: SkuMediaBucket; path: string } | null {
  const clean = String(value ?? "")
    .trim()
    .replace(/^\/+/, "");
  if (!clean || isHttpUrl(clean)) return null;
  const idx = clean.indexOf("/");
  if (idx <= 0) return null;
  const bucket = clean.slice(0, idx) as SkuMediaBucket;
  const path = clean.slice(idx + 1);
  if (!SKU_MEDIA_BUCKETS.includes(bucket) || !path) return null;
  if (path.includes("..")) return null;
  return { bucket, path };
}

/** 站点对外 origin。发布域优先，可用 PUBLIC_APP_ORIGIN 覆盖。 */
export function getPublicOrigin(): string {
  const raw =
    process.env["PUBLIC_APP_ORIGIN"]?.trim() ||
    process.env["PUBLIC_SITE_URL"]?.trim() ||
    "https://boomer-off-buddy.lovable.app";
  return raw.replace(/\/+$/, "");
}

/** 单个值（http 外链或桶路径）→ 对外可取 URL；无法解析返回 null。 */
export function buildPublicSkuMediaUrl(value: string, origin: string): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (isHttpUrl(raw)) {
    // 过期签名 URL 不能交给外部渠道抓取
    if (raw.includes("token=")) return null;
    return raw;
  }
  const parsed = parseSkuMediaPath(raw);
  if (!parsed) return null;
  const encoded = parsed.path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${origin.replace(/\/+$/, "")}${PUBLIC_SKU_MEDIA_PREFIX}/${parsed.bucket}/${encoded}`;
}

/** 批量解析并去重，保持顺序。 */
export function resolvePublicSkuImageUrls(
  values: Array<string | null | undefined>,
  origin: string,
  limit = 5,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const url = buildPublicSkuMediaUrl(String(value), origin);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}
