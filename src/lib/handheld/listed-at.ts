// 手持商品列表「上架时间」：只取当前已授权门店自身的 commerce_listings.published_at；
// 无本店发布记录/日期无效时仅回退 inv_skus.created_at，绝不使用 updated_at 或别店记录。
export type ListedAtSource = "store_listing_published_at" | "sku_created_at_fallback" | "unavailable";
export type ListingRow = { sku_id: string; location_id: string; published_at: string | null };

const validMs = (v: string | null | undefined): number | null => {
  if (typeof v !== "string" || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

/** 仅保留 location_id 精确等于本店的行；(sku_id, location_id) 唯一。 */
export function storePublishedAtMap(rows: ListingRow[], storeLocationId: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!storeLocationId) return map;
  for (const r of rows) {
    if (r.location_id !== storeLocationId || validMs(r.published_at) === null) continue;
    map.set(r.sku_id, new Date(validMs(r.published_at)!).toISOString());
  }
  return map;
}

export function resolveListedAt(
  item: { id: string; created_at: string },
  published: Map<string, string>,
): { listed_at: string | null; listed_at_source: ListedAtSource } {
  const p = published.get(item.id);
  if (p) return { listed_at: p, listed_at_source: "store_listing_published_at" };
  const c = validMs(item.created_at);
  if (c !== null) return { listed_at: new Date(c).toISOString(), listed_at_source: "sku_created_at_fallback" };
  return { listed_at: null, listed_at_source: "unavailable" };
}

/** 无有效时间者一律排在最后；同一时间按 id 稳定排序（由调用方兜底）。 */
export function compareListed(
  a: { listed_at: string | null },
  b: { listed_at: string | null },
  dir: "desc" | "asc",
): number {
  const x = validMs(a.listed_at), y = validMs(b.listed_at);
  if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
  return dir === "desc" ? y - x : x - y;
}
