export const STANDARD_CATALOG_SYNC_CONFIRM = "SYNC_STANDARD_CATALOG";
export const STANDARD_CATALOG_SYNC_HOST = "erp.boomeroff.com";

export type StandardCatalogTargetShop = {
  id: string;
  shop_name: string;
  kdt_id: number | string;
  role?: string | null;
  status?: string | null;
};

export type StandardCatalogSyncRequest = {
  dry_run?: unknown;
  confirm?: unknown;
  limit?: unknown;
  offset?: unknown;
  target_stock?: unknown;
};

export function buildStandardYouzanRemoteIdentity(input: {
  skuId: string;
  skuCode: string;
  barcode?: string | null;
  name: string;
  priceTier: number | string;
}) {
  const price = Number(input.priceTier);
  const barcode = String(input.barcode ?? "").trim();
  if (/^\d{8,32}$/.test(barcode)) {
    const displayPrice = Number.isInteger(price) ? String(price) : price.toFixed(1);
    return { code: barcode, name: `${input.name} ${displayPrice}元` };
  }
  const priceToken = Math.round(price * 10)
    .toString()
    .padStart(5, "0");
  const rowToken = input.skuId.replace(/-/g, "").slice(0, 8).toUpperCase();
  const suffix = `-${priceToken}-${rowToken}`;
  const code = `${input.skuCode.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
  const displayPrice = Number.isInteger(price) ? String(price) : price.toFixed(1);
  return { code, name: `${input.name} ${displayPrice}元` };
}

export function buildHqSpuLookupParams(code: string) {
  const normalized = code.trim();
  if (!normalized) return [{ page_no: 1, page_size: 100 }];
  return [
    { page_no: 1, page_size: 100, spu_codes: [normalized] },
    { page_no: 1, page_size: 100, sku_codes: [normalized] },
    { page_no: 1, page_size: 100 },
  ];
}

export function selectStandardCatalogTargetShops(
  shops: StandardCatalogTargetShop[],
): StandardCatalogTargetShop[] {
  const seenKdtIds = new Set<number>();
  return shops.filter((shop) => {
    const kdtId = Number(shop.kdt_id);
    if (shop.role !== "branch" || shop.status !== "active") return false;
    if (!Number.isSafeInteger(kdtId) || kdtId <= 0 || seenKdtIds.has(kdtId)) return false;
    seenKdtIds.add(kdtId);
    return true;
  });
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function parseStandardCatalogSyncRequest(body: StandardCatalogSyncRequest) {
  const dryRun = body.dry_run !== false;
  const confirm = typeof body.confirm === "string" ? body.confirm : "";
  if (!dryRun && confirm !== STANDARD_CATALOG_SYNC_CONFIRM) {
    throw new Error(`正式同步必须传 confirm=${STANDARD_CATALOG_SYNC_CONFIRM}`);
  }
  return {
    dryRun,
    confirm,
    limit: boundedInteger(body.limit, 10, 1, 20),
    offset: boundedInteger(body.offset, 0, 0, 100_000),
    targetStock: boundedInteger(body.target_stock, 9999, 1, 9999),
  };
}

export function assertStandardCatalogSyncHost(hostname: string, dryRun: boolean): void {
  if (!dryRun && hostname !== STANDARD_CATALOG_SYNC_HOST) {
    throw new Error(`正式同步只能从腾讯固定出口 ${STANDARD_CATALOG_SYNC_HOST} 执行`);
  }
}
