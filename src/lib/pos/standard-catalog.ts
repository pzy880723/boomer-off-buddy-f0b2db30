// POS 标准商品目录（14 个一级类目 x 32 个价格档）的纯逻辑，
// 由 /api/public/pos/standard-catalog 与回归测试共用。

import { INV_CATEGORIES, PRICE_TIERS } from "@/lib/inventory.helpers";

/** 系统兜底类目：不生成标准商品、永不出现在 POS */
export const SYSTEM_FALLBACK_CATEGORY_CODES = [
  "classification_pending",
  "ai_low_confidence",
  "new_category_candidate",
  "compliance_review",
] as const;

export const STANDARD_CATEGORY_CODES = INV_CATEGORIES.map((item) => item.value);
export const STANDARD_PRICE_TIERS = [...PRICE_TIERS];

export type CategoryRowLike = {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  is_active: boolean;
  sort_order?: number | null;
};

export type StandardSkuRowLike = {
  id: string;
  category: string;
  name: string;
  price_tier: number | string;
};

export type StandardCatalogGroup = {
  category_code: string;
  category_name: string;
  subcategories: Array<{ code: string; name: string }>;
  prices: Array<{ sku_id: string; price: number }>;
};

export function isSystemFallbackCategory(code: string): boolean {
  return (SYSTEM_FALLBACK_CATEGORY_CODES as readonly string[]).includes(code);
}

/**
 * 组装 POS 标准商品目录。
 * - 只输出 14 个业务一级类目，顺序固定
 * - 永不输出系统兜底类目
 * - 二级类目只作为 POS 订单的可选分析字段，不参与 SKU 组合
 */
export function buildStandardCatalog(
  categories: CategoryRowLike[],
  skus: StandardSkuRowLike[],
): StandardCatalogGroup[] {
  const byId = new Map(categories.map((row) => [row.id, row]));
  const byCode = new Map(categories.map((row) => [row.code, row]));

  return STANDARD_CATEGORY_CODES.filter((code) => !isSystemFallbackCategory(code)).map((code) => {
    const root = byCode.get(code);
    const fallbackName = INV_CATEGORIES.find((item) => item.value === code)!.label;
    const subcategories = categories
      .filter(
        (row) =>
          row.is_active &&
          row.parent_id !== null &&
          byId.get(row.parent_id)?.code === code &&
          !isSystemFallbackCategory(row.code),
      )
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((row) => ({ code: row.code, name: row.name }));

    const prices = skus
      .filter((sku) => sku.category === code)
      .map((sku) => ({ sku_id: sku.id, price: Number(sku.price_tier) }))
      .sort((a, b) => a.price - b.price);

    return {
      category_code: code,
      category_name: root?.name ?? fallbackName,
      subcategories,
      prices,
    };
  });
}
