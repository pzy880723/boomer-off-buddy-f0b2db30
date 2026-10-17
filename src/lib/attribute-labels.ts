/**
 * 统一中文字段字典：ERP、手持、店面共用。
 * 规则：未知键返回 null，调用方必须隐藏，禁止回退显示原始英文键。
 * 只翻译“字段名/维度名”，不改品牌官方原名等取值。
 */
export const FACET_DIMENSION_LABELS: Record<string, string> = {
  object_type: "物件形态",
  function: "功能用途",
  origin: "产地",
  material: "材质",
  era: "年代",
  craft: "工艺",
  style: "风格",
  ip: "IP/作品",
  character: "角色",
  series: "系列",
  release_method: "发行方式",
};

export const RECOGNITION_ATTRIBUTE_KEYS = [
  "brand",
  "maker",
  "origin_region",
  "origin_country",
  "era",
  "material",
  "craft",
  "object_type",
  "colors",
  "dimensions",
  "functional_status",
  "missing_parts",
] as const;

const ATTRIBUTE_KEY_LABELS: Record<string, string> = {
  brand: "品牌",
  maker: "制造商",
  origin_region: "产地地区",
  origin_country: "原产国",
  era: "年代",
  material: "材质",
  craft: "工艺",
  object_type: "物件形态",
  colors: "颜色",
  dimensions: "尺寸",
  functional_status: "功能状态",
  missing_parts: "缺失配件",
};

const own = (map: Record<string, string>, key: string) =>
  Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;

export function facetDimensionLabel(dimension: string): string | null {
  return own(FACET_DIMENSION_LABELS, dimension);
}

export function attributeKeyLabel(key: string): string | null {
  return own(ATTRIBUTE_KEY_LABELS, key) ?? own(FACET_DIMENSION_LABELS, key);
}

export function labelFacets<T extends { dimension: string }>(
  facets: readonly T[],
): Array<T & { dimension_label: string }> {
  return facets.flatMap((facet) => {
    const dimension_label = facetDimensionLabel(facet.dimension);
    return dimension_label ? [{ ...facet, dimension_label }] : [];
  });
}
