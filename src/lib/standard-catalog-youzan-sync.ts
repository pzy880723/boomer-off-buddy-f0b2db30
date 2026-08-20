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

export function buildStandardHqBarcodeFields(barcode: string) {
  const normalized = barcode.trim();
  if (!/^\d{8,32}$/.test(normalized)) {
    throw new Error("标准商品缺少有效收银条码");
  }
  return {
    spu_no: normalized,
    bar_codes: [normalized],
  };
}

export function buildStandardHqSkuBarcodeFields(input: {
  skuId: number;
  skuCode: string;
  barcode: string;
  retailPrice: number | string;
}) {
  const skuCode = input.skuCode.trim();
  if (!Number.isSafeInteger(input.skuId) || input.skuId <= 0 || !skuCode) {
    throw new Error("有赞总部商品缺少有效规格标识");
  }
  const { spu_no: barcode, bar_codes } = buildStandardHqBarcodeFields(input.barcode);
  return {
    sku_id: input.skuId,
    sku_code: skuCode,
    sku_no: barcode,
    bar_codes,
    retail_price: Number(input.retailPrice).toFixed(2),
  };
}

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
  if (!normalized) return [{ page_no: 1, page_size: 20 }];
  return [
    { page_no: 1, page_size: 20, spu_codes: [normalized] },
    { page_no: 1, page_size: 20, sku_codes: [normalized] },
    { page_no: 1, page_size: 20 },
  ];
}

export type HqSpuRemoteIdentity = {
  spuId: number;
  spuCode: string;
  skuId: number | null;
  skuCode: string;
};

export function selectHqSpuRemoteIdentity(
  rows: Array<Record<string, unknown>>,
  target: { spuId?: number; code?: string; name?: string },
): HqSpuRemoteIdentity | null {
  const spuId = Number(target.spuId ?? 0);
  const code = String(target.code ?? "").trim();
  const name = String(target.name ?? "").trim();
  const matchesCode = (row: Record<string, unknown>) => {
    const skus = Array.isArray(row.skus)
      ? (row.skus as Array<Record<string, unknown>>)
      : [];
    return (
      [row.spu_code, row.spuCode, row.outer_id, row.outerId].some(
        (value) => String(value ?? "") === code,
      ) ||
      skus.some((sku) =>
        [sku.sku_code, sku.skuCode, sku.outer_sku_id, sku.outerSkuId, sku.sku_no].some(
          (value) => String(value ?? "") === code,
        ),
      )
    );
  };
  const matched = spuId > 0
    ? rows.find((row) => Number(row.spu_id ?? row.spuId ?? row.item_id ?? row.id ?? 0) === spuId)
    : code
      ? rows.find(matchesCode)
      : rows.find(
          (row) => String(row.product_name ?? row.productName ?? row.name ?? "").trim() === name,
        );
  if (!matched) return null;

  const skus = Array.isArray(matched.skus)
    ? (matched.skus as Array<Record<string, unknown>>)
    : [];
  const remoteSpuId = Number(
    matched.spu_id ?? matched.spuId ?? matched.item_id ?? matched.id ?? 0,
  );
  const remoteSpuCode = String(
    matched.spu_code ?? matched.spuCode ?? matched.outer_id ?? matched.outerId ?? "",
  ).trim();
  const remoteSkuId = Number(skus[0]?.sku_id ?? skus[0]?.skuId ?? 0) || null;
  const remoteSkuCode = String(
    skus[0]?.sku_code ??
      skus[0]?.skuCode ??
      skus[0]?.outer_sku_id ??
      skus[0]?.outerSkuId ??
      remoteSpuCode,
  ).trim();
  if (!remoteSpuId || !remoteSpuCode || !remoteSkuCode) return null;
  return {
    spuId: remoteSpuId,
    spuCode: remoteSpuCode,
    skuId: remoteSkuId,
    skuCode: remoteSkuCode,
  };
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
