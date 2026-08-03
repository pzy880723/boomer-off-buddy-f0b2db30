export const CITIC_TAIFU_YOUZAN_SHOP_ID = "da06cdae-5ec1-4749-8dcb-dc972cfd05c9";
export const STANDARD_CATALOG_SYNC_CONFIRM = "SYNC_STANDARD_CATALOG";
export const STANDARD_CATALOG_SYNC_HOST = "erp.boomeroff.com";

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
  name: string;
  priceTier: number | string;
}) {
  const price = Number(input.priceTier);
  const priceToken = Math.round(price * 10)
    .toString()
    .padStart(5, "0");
  const rowToken = input.skuId.replace(/-/g, "").slice(0, 8).toUpperCase();
  const suffix = `-${priceToken}-${rowToken}`;
  const code = `${input.skuCode.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
  const displayPrice = Number.isInteger(price) ? String(price) : price.toFixed(1);
  return { code, name: `${input.name} ${displayPrice}元` };
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
    shopId: CITIC_TAIFU_YOUZAN_SHOP_ID,
  };
}

export function assertStandardCatalogSyncHost(hostname: string, dryRun: boolean): void {
  if (!dryRun && hostname !== STANDARD_CATALOG_SYNC_HOST) {
    throw new Error(`正式同步只能从腾讯固定出口 ${STANDARD_CATALOG_SYNC_HOST} 执行`);
  }
}
