// 全局标准商品目录的门店继承规则（纯逻辑，供 serverFn 与回归测试共用）
//
// 业务语义：标准商品在 inv_skus 中只有一份全局主数据，不为门店复制 SKU、
// 也不为无限库存标准商品写 inv_stocks。所有 Vintage 门店无条件自动可售。

export const VINTAGE_STORE_FORMAT = "vintage";

/** 全局标准商品的判定条件（同时用于 supabase 查询与测试断言） */
export const GLOBAL_STANDARD_SKU_FILTER = {
  kind: "single",
  is_custom_price: false,
  inventory_policy: "unlimited",
  is_display: true,
  status: "active",
} as const;

export function inheritsGlobalStandardCatalog(storeFormat: string | null | undefined): boolean {
  return storeFormat === VINTAGE_STORE_FORMAT;
}

export type ShopSkuIdSources = {
  storeFormat: string | null | undefined;
  /** 门店库存行（含 qty=0） */
  stockSkuIds: string[];
  /** 门店有赞 link */
  linkSkuIds: string[];
  /** 门店库存流水 */
  movementSkuIds: string[];
  /** 全局标准商品（已按 GLOBAL_STANDARD_SKU_FILTER 过滤） */
  globalStandardSkuIds: string[];
};

/** 门店视角可见的 SKU 集合：门店特有商品按库存/link/流水隔离，标准商品全局继承 */
export function resolveShopVisibleSkuIds(sources: ShopSkuIdSources): string[] {
  const ids = new Set<string>();
  for (const id of sources.stockSkuIds) ids.add(id);
  for (const id of sources.linkSkuIds) ids.add(id);
  for (const id of sources.movementSkuIds) ids.add(id);
  if (inheritsGlobalStandardCatalog(sources.storeFormat)) {
    for (const id of sources.globalStandardSkuIds) ids.add(id);
  }
  return Array.from(ids);
}
