// Server-only helper: 把 inv_skus.image_paths（混合了 "bucket/path" 私桶引用 和 http(s) 外链）
// 转成可直接 <img src=…> 的 URL 列表。
//
// - http(s):// 开头：原样返回
// - 私桶（sku-raw, sku-listing, parcel-item-images, domestic-order-screenshots, domestic-bulk-attachments）：用 service-role
//   一次性 createSignedUrls 24 小时
// - 未识别前缀：返回 null（前端跳过）
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const PRIVATE_BUCKETS = new Set([
  "sku-raw",
  "sku-listing",
  "parcel-item-images",
  "domestic-order-screenshots",
  "domestic-bulk-attachments",
]);

const SIGNED_TTL = 60 * 60 * 24; // 24h

type Slot = { idx: number; bucket: string; path: string };

export async function signSkuImagePaths(paths: readonly string[]): Promise<(string | null)[]> {
  if (!paths || paths.length === 0) return [];
  const out: (string | null)[] = new Array(paths.length).fill(null);
  const slotsByBucket = new Map<string, Slot[]>();

  paths.forEach((raw, idx) => {
    if (!raw) return;
    const s = String(raw).trim();
    if (!s) return;
    if (/^https?:\/\//i.test(s) || s.startsWith("data:")) {
      out[idx] = s;
      return;
    }
    const slash = s.indexOf("/");
    if (slash <= 0) return;
    const bucket = s.slice(0, slash);
    const path = s.slice(slash + 1);
    if (!PRIVATE_BUCKETS.has(bucket) || !path) return;
    const arr = slotsByBucket.get(bucket) ?? [];
    arr.push({ idx, bucket, path });
    slotsByBucket.set(bucket, arr);
  });

  await Promise.all(
    Array.from(slotsByBucket.entries()).map(async ([bucket, slots]) => {
      const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUrls(
        slots.map((s) => s.path),
        SIGNED_TTL,
      );
      if (error || !data) return;
      data.forEach((row, i) => {
        const slot = slots[i];
        if (row?.signedUrl) out[slot.idx] = row.signedUrl;
      });
    }),
  );

  return out;
}

/** 单图便捷版：返回第 0 张的 URL（首选 image_paths，回退 image_url） */
export async function signSkuCover(
  imagePaths: readonly string[] | null | undefined,
  fallbackImageUrl?: string | null,
): Promise<string | null> {
  if (imagePaths && imagePaths.length > 0) {
    const signed = await signSkuImagePaths([imagePaths[0]]);
    if (signed[0]) return signed[0];
  }
  if (
    fallbackImageUrl &&
    /^https?:\/\//i.test(fallbackImageUrl) &&
    !fallbackImageUrl.includes("token=")
  ) {
    return fallbackImageUrl;
  }
  return null;
}

export const THUMBNAIL_TRANSFORM = { width: 480, resize: "contain", quality: 75 } as const;
const THUMBNAIL_CONCURRENCY = 4;

/**
 * 缩略图签名：storage-js 的 createSignedUrls 批量接口不支持 transform（只支持 download/cacheNonce），
 * 因此按“去重后的路径”逐个调用 createSignedUrl(path, ttl, { transform })，并发上限 4。
 * 只对私桶路径生效；外链 / 未知前缀 / 签名失败一律返回 null，由调用方回退原图。
 */
export async function signSkuThumbnailPaths(
  paths: readonly string[],
  transform: {
    width: number;
    resize?: "cover" | "contain" | "fill";
    quality?: number;
  } = THUMBNAIL_TRANSFORM,
): Promise<(string | null)[]> {
  if (!paths || paths.length === 0) return [];
  const out: (string | null)[] = new Array(paths.length).fill(null);
  const unique = new Map<string, { bucket: string; path: string; idxs: number[] }>();
  paths.forEach((raw, idx) => {
    const s = String(raw ?? "").trim();
    const slash = s.indexOf("/");
    if (!s || /^https?:\/\//i.test(s) || s.startsWith("data:") || slash <= 0) return;
    const bucket = s.slice(0, slash);
    const path = s.slice(slash + 1);
    if (!PRIVATE_BUCKETS.has(bucket) || !path) return;
    const entry = unique.get(s) ?? { bucket, path, idxs: [] };
    entry.idxs.push(idx);
    unique.set(s, entry);
  });
  const jobs = Array.from(unique.values());
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      try {
        const { data, error } = await supabaseAdmin.storage
          .from(job.bucket)
          .createSignedUrl(job.path, SIGNED_TTL, { transform });
        if (error || !data?.signedUrl) continue;
        for (const i of job.idxs) out[i] = data.signedUrl;
      } catch {
        // 保持 null → 调用方回退原图
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(THUMBNAIL_CONCURRENCY, jobs.length) }, () => worker()),
  );
  return out;
}
