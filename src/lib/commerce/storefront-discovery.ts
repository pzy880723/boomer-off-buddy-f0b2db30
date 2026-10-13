// Discovery tags backed by real, currently purchasable products.
// Counting mirrors search_inv_skus single-filter semantics: brand_id equality, SKU has facet code,
// category equals code or its parent code. Search counts are only ever the real searchers value.
export const DISCOVERY_LIMIT = 12;
const FALLBACK_FACET_DIMENSIONS = ["ip", "character", "series"] as const;

export type DiscoveryProduct = {
  brand: { id: string; name: string } | null;
  facets: Array<{ dimension: string; code: string; name: string }>;
  primary_category: { code: string; name?: string };
};
export type TagCount = { key: string; label: string; kind: "brand" | "facet" | "category"; dimension?: string; count: number };
export type DiscoveryFilters = { brand_ids?: string[]; facet_codes?: string[]; primary_category?: string };
export type DiscoveryTerm = {
  key: string; label: string; query: string; product_count: number; search_count: number | null; filters: DiscoveryFilters;
};

export function countAvailableTags(products: readonly DiscoveryProduct[], categoryParent: ReadonlyMap<string, string | null>) {
  const out = new Map<string, TagCount>();
  const bump = (key: string, init: Omit<TagCount, "count" | "key">) => {
    const e = out.get(key) ?? { key, ...init, count: 0 };
    e.count += 1; out.set(key, e);
  };
  for (const p of products) {
    const seen = new Set<string>();
    const once = (key: string, init: Omit<TagCount, "count" | "key">) => { if (!seen.has(key)) { seen.add(key); bump(key, init); } };
    if (p.brand?.id) once(`brand:${p.brand.id}`, { label: p.brand.name, kind: "brand" });
    for (const f of p.facets) once(`facet:${f.code}`, { label: f.name, kind: "facet", dimension: f.dimension });
    const code = p.primary_category?.code;
    if (code) {
      once(`category:${code}`, { label: p.primary_category.name ?? code, kind: "category" });
      const parent = categoryParent.get(code);
      if (parent) once(`category:${parent}`, { label: parent, kind: "category" });
    }
  }
  return out;
}

function filtersFor(key: string): DiscoveryFilters | null {
  const m = /^(brand|facet|category):([A-Za-z0-9_-]{1,80})$/.exec(key);
  if (!m) return null;
  if (m[1] === "brand") return { brand_ids: [m[2]] };
  if (m[1] === "facet") return { facet_codes: [m[2]] };
  return { primary_category: m[2] };
}

const KIND_RANK = (t: TagCount) => t.kind === "brand" ? 0 : FALLBACK_FACET_DIMENSIONS.indexOf(t.dimension as never) + 1;

export function buildDiscoveryTerms(
  hot: ReadonlyArray<{ term_key: string; label: string; searchers: number }>,
  counts: ReadonlyMap<string, TagCount>,
  limit = DISCOVERY_LIMIT,
): DiscoveryTerm[] {
  const out: DiscoveryTerm[] = [];
  const used = new Set<string>();
  for (const h of hot) {
    const filters = filtersFor(h.term_key);
    const c = counts.get(h.term_key);
    if (!filters || !c || c.count < 1 || used.has(h.term_key)) continue;
    used.add(h.term_key);
    out.push({ key: h.term_key, label: h.label, query: h.label, product_count: c.count, search_count: Number(h.searchers) || 0, filters });
    if (out.length >= limit) return out;
  }
  const fallback = [...counts.values()]
    .filter((t) => !used.has(t.key) && t.count > 0 &&
      (t.kind === "brand" || (t.kind === "facet" && (FALLBACK_FACET_DIMENSIONS as readonly string[]).includes(t.dimension ?? ""))))
    .filter((t) => filtersFor(t.key))
    .sort((a, b) => b.count - a.count || KIND_RANK(a) - KIND_RANK(b) || a.label.localeCompare(b.label, "zh-CN") || a.key.localeCompare(b.key));
  for (const t of fallback) {
    if (out.length >= limit) break;
    out.push({ key: t.key, label: t.label, query: t.label, product_count: t.count, search_count: null, filters: filtersFor(t.key)! });
  }
  return out;
}
