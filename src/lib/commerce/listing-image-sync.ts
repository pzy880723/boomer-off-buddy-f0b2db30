/**
 * 成图完成后，把官方商城 listing 上仍然引用的「原图」路径替换成同一张图的成图路径。
 *
 * 铁律：
 *  - 只替换与本次任务完全相等的原图 key，人工单独挑的商城图（其它任何路径）原样保留；
 *  - 成图失败/没有产出时绝不清空或覆盖已有有效图片；
 *  - 只动 image_paths，不碰上下架状态、售罄、价格、库存，也不新增第二套图片字段。
 */
export function applyListingImageReplacement(
  current: readonly unknown[] | null | undefined,
  rawKey: string,
  listingKey: string,
): { changed: boolean; next: string[] } {
  const paths = (current ?? [])
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0);

  if (!rawKey || !listingKey) return { changed: false, next: paths };
  if (!paths.includes(rawKey)) return { changed: false, next: paths };

  const replaced = paths.map((p) => (p === rawKey ? listingKey : p));
  const next = [...new Set(replaced)];
  const changed = next.length !== paths.length || next.some((p, i) => p !== paths[i]);
  return { changed, next };
}
