// SKU 封面批量签名的纯逻辑（可单测，不依赖 service-role client）。
//
// 背景：signSkuCovers 原来对每个 SKU 各调一次 signSkuCover，而 signSkuCover 每次只把
// 1 个路径交给 signSkuImagePaths，导致「按桶批量签名」能力完全失效：448 个标准 SKU
// 会瞬时发出 448 个 POST /storage/v1/object/sign，而其中通常只有十几张不同的图。
//
// 这里把「候选首图 → 去重 → 一次批量签名 → 回填」的组装逻辑抽成纯函数：
// - 首图优先级不变：image_paths[0]，取不到再回退 image_url
// - http(s) / data: 值原样透传，不进签名批次
// - image_url 回退规则不变：必须是 http(s) 且不含 token=
// - 签名 TTL 由调用方的 signer（signSkuImagePaths，24h）决定，这里不涉及
// - 关键差异：需要签名的首图签名失败且没有可用回退时，明确抛错，不伪装成「本来无图」

export const PRIVATE_BUCKETS = new Set([
  "sku-raw",
  "sku-listing",
  "parcel-item-images",
  "domestic-order-screenshots",
  "domestic-bulk-attachments",
]);

export type SkuCoverSource = {
  id: string;
  image_paths?: readonly string[] | null;
  image_url?: string | null;
};

export type CoverSigner = (paths: readonly string[]) => Promise<(string | null)[]>;

/** http(s) 或 data: 值可直接使用，不需要签名 */
export function isDirectImageValue(value: string): boolean {
  return /^https?:\/\//i.test(value) || value.startsWith("data:");
}

/** 解析 `bucket/path` 形式的私桶引用；非私桶或格式不对返回 null */
export function parsePrivateBucketRef(value: string): { bucket: string; path: string } | null {
  const slash = value.indexOf("/");
  if (slash <= 0) return null;
  const bucket = value.slice(0, slash);
  const path = value.slice(slash + 1);
  if (!PRIVATE_BUCKETS.has(bucket) || !path) return null;
  return { bucket, path };
}

/** image_url 回退是否可用：必须是 http(s) 且不是已签名 URL */
export function isUsableFallbackUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^https?:\/\//i.test(value) && !value.includes("token=");
}

function firstCandidate(paths: readonly string[] | null | undefined): string | null {
  if (!paths || paths.length === 0) return null;
  const first = String(paths[0] ?? "").trim();
  return first || null;
}

/**
 * 批量解析一组 SKU 的封面 URL。
 * 所有需要签名的首图会去重后**只调一次** signer，由 signer 内部按桶批量签名。
 *
 * @throws 当某个 SKU 的首图需要签名但签名失败，且没有可用的 image_url 回退时抛出。
 */
export async function buildSkuCovers(
  rows: readonly SkuCoverSource[],
  signer: CoverSigner,
): Promise<Record<string, string | null>> {
  const covers: Record<string, string | null> = {};
  // 需要签名的行：sku id → 原始路径
  const pending: Array<{ id: string; ref: string; fallback: string | null }> = [];
  const uniqueRefs: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const fallback = isUsableFallbackUrl(row.image_url) ? String(row.image_url) : null;
    const candidate = firstCandidate(row.image_paths);

    if (candidate && isDirectImageValue(candidate)) {
      covers[row.id] = candidate;
      continue;
    }
    if (candidate && parsePrivateBucketRef(candidate)) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        uniqueRefs.push(candidate);
      }
      pending.push({ id: row.id, ref: candidate, fallback });
      continue;
    }
    // 无首图 / 无法识别的前缀：按原有优先级回退 image_url
    covers[row.id] = fallback;
  }

  if (uniqueRefs.length === 0) return covers;

  const signed = await signer(uniqueRefs);
  const signedByRef = new Map<string, string | null>();
  uniqueRefs.forEach((ref, i) => signedByRef.set(ref, signed[i] ?? null));

  const failed: string[] = [];
  for (const item of pending) {
    const url = signedByRef.get(item.ref) ?? null;
    if (url) {
      covers[item.id] = url;
      continue;
    }
    if (item.fallback) {
      covers[item.id] = item.fallback;
      continue;
    }
    failed.push(item.id);
  }

  if (failed.length > 0) {
    throw new Error(
      `商品封面签名失败（${failed.length} 个 SKU 无可用回退图）：${failed.slice(0, 5).join(", ")}`,
    );
  }
  return covers;
}
