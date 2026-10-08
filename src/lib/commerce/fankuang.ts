/**
 * 翻筐乐参与规则（纯函数，ERP / 手持 / 商城共用）。
 * fankuang_override: NULL = 按售价自动（<= 49.9 参与），true / false = 人工覆盖（优先于价格）。
 * 仅库存跟踪的自定义单件可参与；标准 / 不限量 / 组包商品恒为 false。
 */
export const FANKUANG_PRICE_MAX = 49.9;

// PostgREST applies this condition before ORDER/LIMIT, matching isInFankuang.
export const FANKUANG_POSTGREST_FILTER = `and(is_custom_price.eq.true,or(kind.is.null,kind.eq.single),or(inventory_policy.is.null,inventory_policy.neq.unlimited),or(fankuang_override.eq.true,and(fankuang_override.is.null,price_tier.gt.0,price_tier.lte.${FANKUANG_PRICE_MAX})))`;

export function fankuangDefaultForPrice(price: number | string | null | undefined): boolean {
  const p = Number(price);
  return Number.isFinite(p) && p > 0 && Math.round(p * 100) <= Math.round(FANKUANG_PRICE_MAX * 100);
}

export type FankuangSkuLike = {
  is_custom_price?: boolean | null;
  inventory_policy?: string | null;
  kind?: string | null;
  price_tier?: number | string | null;
  fankuang_override?: boolean | null;
};

export function isFankuangEligibleSku(sku: FankuangSkuLike): boolean {
  return (
    sku.is_custom_price === true &&
    (sku.inventory_policy ?? "tracked") !== "unlimited" &&
    (sku.kind ?? "single") === "single"
  );
}

export function isInFankuang(sku: FankuangSkuLike): boolean {
  if (!isFankuangEligibleSku(sku)) return false;
  if (sku.fankuang_override === true) return true;
  if (sku.fankuang_override === false) return false;
  return fankuangDefaultForPrice(sku.price_tier);
}

/** 在分页前过滤，total 只统计参与项。 */
export function filterFankuangBeforePaging<T extends { in_fankuang: boolean }>(
  items: readonly T[],
  onlyFankuang: boolean,
  page: number,
  pageSize: number,
): { total: number; page: T[] } {
  const filtered = onlyFankuang ? items.filter((i) => i.in_fankuang) : [...items];
  const start = (page - 1) * pageSize;
  return { total: filtered.length, page: filtered.slice(start, start + pageSize) };
}
