export type FacetSelectionCategory = {
  id: string;
  code: string;
  parent_id: string | null;
};

export type FacetSelectionCandidate = {
  id: string;
  code: string;
  name: string;
  category_codes: string[] | null;
};

export function resolveFacetSelection(input: {
  categoryCode: string;
  categories: FacetSelectionCategory[];
  facets: FacetSelectionCandidate[];
  facetCodes?: string[];
  legacyTags?: string[];
}): FacetSelectionCandidate[] {
  const category = input.categories.find((row) => row.code === input.categoryCode);
  if (!category) throw new Error("商品分类不存在或已停用");

  const scopeCodes = new Set([category.code]);
  if (category.parent_id) {
    const parent = input.categories.find((row) => row.id === category.parent_id);
    if (parent) scopeCodes.add(parent.code);
  }

  const byCode = new Map(input.facets.map((facet) => [facet.code, facet]));
  const byName = new Map(input.facets.map((facet) => [facet.name.trim().toLowerCase(), facet]));
  const requested = [
    ...(input.facetCodes ?? []).map((value) => ({ value, by: "code" as const })),
    ...(input.legacyTags ?? []).map((value) => ({ value, by: "name" as const })),
  ];
  const selected = new Map<string, FacetSelectionCandidate>();

  for (const request of requested) {
    const value = request.value.trim();
    if (!value) continue;
    const facet =
      request.by === "code"
        ? byCode.get(value)
        : byCode.get(value) ?? byName.get(value.toLowerCase());
    if (!facet) throw new Error(`商品标签不存在或已停用：${value}`);
    const categoryCodes = facet.category_codes ?? [];
    if (categoryCodes.length > 0 && !categoryCodes.some((code) => scopeCodes.has(code))) {
      throw new Error(`商品标签“${facet.name}”不适用于当前分类`);
    }
    selected.set(facet.code, facet);
  }

  if (selected.size > 20) throw new Error("商品标签最多选择 20 个");
  return Array.from(selected.values());
}
