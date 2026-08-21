export const STANDARD_CATALOG_SYNC_CONFIRM = "SYNC_STANDARD_CATALOG";
export const STANDARD_CATALOG_SYNC_HOST = "erp.boomeroff.com";

export type StandardCatalogTargetShop = {
  id: string;
  shop_name: string;
  kdt_id: number | string;
  warehouse_code?: string | null;
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

export type StandardCatalogSku = {
  id: string;
  sku_code: string | null;
  barcode: string | null;
  name: string;
  category: string | null;
  price_tier: number;
};

export type StandardCatalogGroup = {
  key: string;
  code: string;
  name: string;
  category: string | null;
  skus: StandardCatalogSku[];
};

export function groupStandardCatalogSkus(rows: StandardCatalogSku[]): StandardCatalogGroup[] {
  const groups = new Map<string, StandardCatalogGroup>();
  for (const row of rows) {
    const code = String(row.sku_code ?? "").trim();
    const key = code || `${row.category ?? ""}|${row.name.trim()}`;
    const group = groups.get(key) ?? {
      key,
      code: code || key,
      name: row.name.trim(),
      category: row.category,
      skus: [],
    };
    group.skus.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.skus.sort((a, b) => Number(a.price_tier) - Number(b.price_tier));
  }
  return Array.from(groups.values());
}

export type YouzanRetailCategory = { id: number; name: string };

export function selectValidYouzanRetailCategory(
  categories: YouzanRetailCategory[],
  storedId: number,
): YouzanRetailCategory | null {
  return (
    categories.find((category) => category.id === storedId) ??
    categories.find((category) => category.name === "未分类") ??
    categories[0] ??
    null
  );
}

function requireStandardBarcode(sku: StandardCatalogSku): string {
  const barcode = String(sku.barcode ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(barcode)) {
    throw new Error(`${sku.name} ${sku.price_tier} 缺少有效收银条码`);
  }
  return barcode;
}

function formatPriceSpec(price: number): string {
  return `${Number.isInteger(price) ? price : price.toFixed(1)}元`;
}

export function buildStandardGroupSpuCreateParams(args: {
  group: StandardCatalogGroup;
  categoryId: number;
  kdtIds: number[];
  imageUrl?: string | null;
}) {
  const values = args.group.skus.map((sku, index) => ({
    v: formatPriceSpec(Number(sku.price_tier)),
    vId: index + 1,
  }));
  const skus = args.group.skus.map((sku) => {
    const barcode = requireStandardBarcode(sku);
    const price = Number(sku.price_tier).toFixed(2);
    return {
      sku_no: barcode,
      sku_code: barcode,
      outer_sku_id: barcode,
      retail_price: price,
      standard_price: price,
      specs: [{ name: "价格", value: formatPriceSpec(Number(sku.price_tier)) }],
    };
  });
  const minPrice = Number(args.group.skus[0]?.price_tier ?? 0).toFixed(2);
  return {
    name: args.group.name,
    unit: "件",
    outer_id: args.group.code,
    spu_code: args.group.code,
    category_id: args.categoryId,
    offline_create: true,
    is_up_offline: true,
    retail_price: minPrice,
    ...(args.kdtIds.length > 0 ? { sell_channel_ids: args.kdtIds } : {}),
    ...(args.imageUrl
      ? {
          pic_url: args.imageUrl,
          spu_pic_list: [args.imageUrl],
          spu_img_list: [{ img_url: args.imageUrl }],
        }
      : {}),
    skus,
    spec_define_tuple: JSON.stringify([
      {
        key: { k: "价格", kId: 1 },
        values,
      },
    ]),
  };
}

export function buildStandardGroupOfflineReleaseParams(args: {
  group: StandardCatalogGroup;
  categoryId: number;
  branchKdtIds: number[];
  imageUrls: string[];
  hqSpuCode: string;
  stock: number;
}) {
  const pictures = args.imageUrls.map((url) => ({ url }));
  const minPriceFen = String(Math.round(Number(args.group.skus[0]?.price_tier ?? 0) * 100));
  return {
    join_level_discount: 1,
    measurement: 0,
    category_id: args.categoryId,
    unit: "件",
    sell_type: 1,
    price: minPriceFen,
    title: args.group.name,
    picture: JSON.stringify(pictures),
    spu_code: args.hqSpuCode,
    sku_center_code: args.hqSpuCode,
    sub_kdt_status_param: {
      sale_up_kdt_ids: Array.from(new Set(args.branchKdtIds)),
      sale_down_kdt_ids: [],
    },
    all_batch_operate: -1,
    name: args.group.name,
    display: 1,
    retail_price: minPriceFen,
    photo_url: JSON.stringify(pictures),
    stocks: args.group.skus.map((sku) => {
      const barcode = requireStandardBarcode(sku);
      const priceFen = String(Math.round(Number(sku.price_tier) * 100));
      return {
        price: priceFen,
        cost_price: "0",
        sell_stock_count: String(Math.max(0, Math.trunc(args.stock))),
        sku_no: barcode,
        related_spu_code: args.hqSpuCode,
        related_sku_code: barcode,
        is_sell: 1,
        min_retail_price: priceFen,
        max_retail_price: priceFen,
      };
    }),
  };
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
