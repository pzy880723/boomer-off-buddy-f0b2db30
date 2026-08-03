export const VINTAGE_STORE_FORMAT = "vintage";

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
  stockSkuIds: string[];
  linkSkuIds: string[];
  movementSkuIds: string[];
  globalStandardSkuIds: string[];
};

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
