type FilterProduct = {
  stock: number;
  price: number;
  brand: { id: string; name: string } | null;
  condition_grade: string | null;
  facets: Array<{ dimension: string; code: string; name: string }>;
};

export type StorefrontFilterSelection = {
  brand_ids: string[];
  facet_codes: string[];
  condition_grades?: string[];
  min_price: number | null;
  max_price?: number | null;
};

export function filterStorefrontProducts<T extends FilterProduct>(products: T[], query: StorefrontFilterSelection): T[] {
  const dimensions = new Map<string, Set<string>>();
  const knownCodes = new Map(products.flatMap(product => product.facets.map(facet => [facet.code, facet.dimension] as const)));
  for (const code of query.facet_codes) {
    const dimension = knownCodes.get(code);
    // Unknown / stale codes must yield no result instead of silently removing a constraint.
    if (!dimension) return [];
    if (!dimensions.has(dimension)) dimensions.set(dimension, new Set());
    dimensions.get(dimension)!.add(code);
  }
  return products.filter(product =>
    product.stock > 0 &&
    (query.min_price == null || product.price >= query.min_price) &&
    (query.max_price == null || product.price <= query.max_price) &&
    (!query.brand_ids.length || Boolean(product.brand && query.brand_ids.includes(product.brand.id))) &&
    (!query.condition_grades?.length || Boolean(product.condition_grade && query.condition_grades.includes(product.condition_grade))) &&
    [...dimensions].every(([dimension, codes]) => product.facets.some(facet => facet.dimension === dimension && codes.has(facet.code))),
  );
}

const DIMENSION_LABELS: Record<string, string> = {
  ip: "作品标签", character: "角色", material: "材质", origin: "产地", era: "年代",
  craft: "工艺", usage: "用途", style: "风格", color: "颜色", pattern: "图案",
  theme: "主题", series: "系列", size: "尺寸", season: "季节", audience: "适用人群",
  function: "用途", object_type: "器型 / 品类", release_method: "发售方式",
};
type FilterOption = { value: string; label: string; count: number };
export function buildStorefrontFilterOptions(products: FilterProduct[]) {
  const available = products.filter(product => product.stock > 0);
  const groups = new Map<string, { key: string; label: string; kind: "brand" | "facet" | "condition"; values: Map<string, FilterOption> }>();
  const add = (key: string, label: string, kind: "brand" | "facet" | "condition", value: string, name: string) => {
    if (!groups.has(key)) groups.set(key, { key, label, kind, values: new Map() });
    const values = groups.get(key)!.values;
    const option = values.get(value) ?? { value, label: name, count: 0 };
    option.count++;
    values.set(value, option);
  };
  for (const product of available) {
    if (product.brand) add("brands", "品牌 / IP", "brand", product.brand.id, product.brand.name);
    for (const facet of new Map(product.facets.map(facet => [facet.code, facet])).values()) {
      add(facet.dimension, DIMENSION_LABELS[facet.dimension] ?? facet.dimension, "facet", facet.code, facet.name);
    }
    if (product.condition_grade) add("condition", "成色", "condition", product.condition_grade, `${product.condition_grade}级`);
  }
  const order = ["brands", "ip", "character", "material", "origin", "era", "craft", "function", "usage", "object_type", "release_method", "style", "color", "pattern", "theme", "series", "size", "season", "audience", "condition"];
  const groupOrder = (key: string) => order.includes(key) ? order.indexOf(key) : order.length;
  return {
    total: available.length,
    price: available.length ? { min: Math.min(...available.map(p => p.price)), max: Math.max(...available.map(p => p.price)) } : { min: null, max: null },
    groups: [...groups.values()].sort((a, b) => groupOrder(a.key) - groupOrder(b.key)).map(({ values, ...group }) => ({
      ...group,
      options: [...values.values()].sort((a, b) => a.label.localeCompare(b.label, "zh-CN")),
    })),
  };
}

export async function collectStorefrontPages<T>(load: (offset: number, limit: number) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await load(offset, 500);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}

type CatalogScope = { q: string | null; primary_category: string | null; location_id: string | null };
export function createStorefrontScopeCache<T>(load: (scope: CatalogScope) => Promise<T>, now = Date.now) {
  const entries = new Map<string, { expires: number; promise: Promise<T> }>();
  return (scope: CatalogScope): Promise<T> => {
    const key = JSON.stringify([scope.q, scope.primary_category, scope.location_id]);
    const current = entries.get(key);
    if (current && current.expires > now()) return current.promise;
    if (entries.size >= 32) entries.delete(entries.keys().next().value!);
    const entry = { expires: Infinity, promise: Promise.resolve().then(() => load(scope)) };
    entries.set(key, entry);
    entry.promise = entry.promise.then(value => { entry.expires = now() + 30_000; return value; }, error => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    });
    return entry.promise;
  };
}
