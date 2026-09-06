import { buildStandardYouzanRemoteIdentity } from "./standard-catalog-youzan-sync";
import { resolvePublicSkuImageUrls } from "./sku-media";

export type OfflineProductQueryInput = {
  pageNo?: number;
  pageSize?: number;
  displayStatus?: 0 | 1 | 2;
  warehouseCode?: string;
  nameOrSkuNo?: string;
  itemIds?: number[];
};

export function buildOfflineSkuIdentity(input: {
  id: string;
  skuScope: string | null;
  skuCode: string;
  barcode?: string | null;
  name: string;
  priceTier: number | string;
}) {
  if (input.skuScope === "standard") {
    return buildStandardYouzanRemoteIdentity({
      skuId: input.id,
      skuCode: input.skuCode,
      barcode: input.barcode,
      name: input.name,
      priceTier: input.priceTier,
    });
  }
  return { code: input.skuCode, name: input.name };
}

export function resolveOfflineReleaseSourceImages(input: {
  skuScope: string | null;
  imageUrl?: string | null;
  imagePaths?: unknown[] | null;
  publicOrigin: string;
}) {
  const images = resolvePublicSkuImageUrls(
    [
      input.imageUrl,
      ...(Array.isArray(input.imagePaths)
        ? input.imagePaths.map((value) => (typeof value === "string" ? value : null))
        : []),
    ],
    input.publicOrigin,
    5,
  );
  if (images.length > 0 || input.skuScope !== "standard") return images;
  return [`${input.publicOrigin.replace(/\/+$/, "")}/m-icon-512.png`];
}

export function buildBranchItemShelfRequest(input: { itemId: number; online: boolean }) {
  if (!Number.isInteger(input.itemId) || input.itemId <= 0) {
    throw new Error("Youzan branch item id is required");
  }
  return {
    method: input.online ? "youzan.item.update.listing" : "youzan.item.update.delisting",
    version: input.online ? "3.0.0" : "3.0.1",
    params: { item_id: input.itemId },
  };
}

export function buildCancelBranchChannelParams(input: { branchKdtId: number; hqItemId: number }) {
  if (!Number.isInteger(input.branchKdtId) || input.branchKdtId <= 0) {
    throw new Error("Youzan branch kdt id is required");
  }
  if (!Number.isInteger(input.hqItemId) || input.hqItemId <= 0) {
    throw new Error("Youzan HQ item id is required");
  }
  return {
    request: {
      kdt_id: input.branchKdtId,
      item_ids: [input.hqItemId],
      channel: 1,
    },
  };
}

export function selectNonTargetBranches<T extends { id: string; kdt_id?: string | number | null }>(
  branches: T[],
  targetShopIds: string[],
) {
  const targets = new Set(targetShopIds);
  return branches.filter((branch) => {
    const kdtId = Number(branch.kdt_id ?? 0);
    return !targets.has(branch.id) && Number.isInteger(kdtId) && kdtId > 0;
  });
}

export function pickYouzanHqItemId(payload: unknown): number | null {
  const seen = new Set<unknown>();
  const keys = ["item_id", "itemId", "channel_item_id", "channelItemId", "id"];
  const walk = (value: unknown, depth = 0): number | null => {
    if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const row = value as Record<string, unknown>;
    for (const key of keys) {
      const id = Number(row[key] ?? 0);
      if (Number.isInteger(id) && id > 0) return id;
    }
    for (const child of Object.values(row)) {
      const found = walk(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(payload);
}

export function isYouzanProductNotFoundError(message: string) {
  return /\[(?:121001008|122001001)\]|商品不存在/i.test(message);
}

export function buildOfflineProductQueryParams(input: OfflineProductQueryInput) {
  const pageNo = input.pageNo ?? 1;
  const pageSize = input.pageSize ?? 20;
  if (!Number.isInteger(pageNo) || pageNo < 1) throw new Error("pageNo must be positive");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new Error("pageSize must be between 1 and 50");
  }
  if (pageNo * pageSize > 3300) throw new Error("Youzan page_no * page_size cannot exceed 3300");
  return {
    page_no: pageNo,
    page_size: pageSize,
    ...(input.displayStatus === undefined ? {} : { show_display: input.displayStatus }),
    ...(input.warehouseCode ? { warehouse_code: input.warehouseCode } : {}),
    ...(input.nameOrSkuNo ? { name_or_sku_no: input.nameOrSkuNo } : {}),
    ...(input.itemIds?.length ? { item_ids: input.itemIds } : {}),
  };
}

export type OfflineProductRow = {
  itemId: number;
  title: string;
  spuNo: string | null;
  isDisplay: boolean;
  skus: Array<{ skuId: number; skuNo: string | null; price: number }>;
};

export function parseOfflineProductRows(payload: unknown): OfflineProductRow[] {
  const root = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const data = (root.data && typeof root.data === "object" ? root.data : root) as Record<
    string,
    unknown
  >;
  const rows = Array.isArray(data.offline_spus) ? data.offline_spus : [];
  return rows.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const itemId = Number(row.item_id ?? 0);
    if (!itemId) return [];
    const skuModels = Array.isArray(row.sku_models) ? row.sku_models : [];
    return [
      {
        itemId,
        title: String(row.title ?? ""),
        spuNo: row.spu_no ? String(row.spu_no) : null,
        isDisplay: Number(row.is_display ?? 0) === 1,
        skus: skuModels.flatMap((skuValue) => {
          if (!skuValue || typeof skuValue !== "object") return [];
          const sku = skuValue as Record<string, unknown>;
          const skuId = Number(sku.sku_id ?? 0);
          if (!skuId) return [];
          return [
            {
              skuId,
              skuNo: sku.sku_no ? String(sku.sku_no) : null,
              price: Number(sku.price ?? 0),
            },
          ];
        }),
      },
    ];
  });
}

export function findOfflineProductMatch(
  rows: OfflineProductRow[],
  target: { skuCode: string; name: string },
) {
  const skuCode = target.skuCode.trim();
  const normalizedSkuCode = normalizeYouzanProductCode(skuCode);
  const codesMatch = (value: string | null) =>
    Boolean(
      value && (value === skuCode || normalizeYouzanProductCode(value) === normalizedSkuCode),
    );
  const exactCode = rows.find(
    (row) => codesMatch(row.spuNo) || row.skus.some((remoteSku) => codesMatch(remoteSku.skuNo)),
  );
  if (exactCode) return exactCode;

  const sameTitle = rows.filter((row) => row.title.trim() === target.name.trim());
  return sameTitle.length === 1 ? sameTitle[0] : null;
}

export function normalizeYouzanProductCode(value: string) {
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export function buildOfflineProductLookupTerms(target: { skuCode: string; name: string }) {
  const rawSkuCode = target.skuCode.trim();
  return Array.from(
    new Set(
      [rawSkuCode, normalizeYouzanProductCode(rawSkuCode), target.name.trim()].filter(Boolean),
    ),
  );
}

export function buildOfflineStockQueueRow(args: {
  skuId: string;
  shopId: string;
  locationId: string | null;
  targetStock: number;
}) {
  return {
    sku_id: args.skuId,
    shop_id: args.shopId,
    location_id: args.locationId,
    target_stock: Math.max(0, Math.trunc(args.targetStock)),
    action: "push_stock",
    reason: "offline_product_release",
    status: "pending",
    next_run_at: new Date().toISOString(),
    last_error: null,
  };
}

export function buildOfflineChannelListingRow(args: {
  skuId: string;
  shopId: string;
  hqSpuId: number;
  itemId: number;
  skuIdRemote: number | null;
  stock: number;
  recovered: boolean;
}) {
  return {
    sku_id: args.skuId,
    channel: "youzan_branch_offline",
    shop_id: args.shopId,
    external_spu_id: String(args.hqSpuId),
    external_item_id: String(args.itemId),
    external_sku_id: args.skuIdRemote ? String(args.skuIdRemote) : null,
    listing_status: "published",
    stock_mode: "absolute",
    last_stock: Math.max(0, Math.trunc(args.stock)),
    last_error: null,
    extra: { source: args.recovered ? "offline.spu.query" : "offline.spu.release" },
  };
}

export type OfflineProductReleaseInput = {
  title: string;
  categoryId: number;
  unit: string;
  priceYuan: number;
  imageUrls: string[];
  spuCode: string;
  skuCenterCode: string;
  saleUpKdtIds: number[];
  saleDownKdtIds: number[];
  stock: {
    skuNo: string;
    relatedSpuCode: string;
    relatedSkuCode: string;
    sellStockCount: number;
  };
};

export function buildOfflineSkuReleaseInput(args: {
  sku: {
    name: string;
    scanCode: string;
    hqSpuCode: string;
    hqSkuCode: string;
    priceYuan: number;
    imageUrls: string[];
  };
  categoryId: number;
  branchKdtIds: number[];
  stock: number;
}): OfflineProductReleaseInput {
  const scanCode = args.sku.scanCode.trim();
  const hqSpuCode = args.sku.hqSpuCode.trim();
  const hqSkuCode = args.sku.hqSkuCode.trim();
  const branchKdtIds = Array.from(
    new Set(args.branchKdtIds.filter((id) => Number.isInteger(id) && id > 0)),
  );
  if (!scanCode) throw new Error("SKU 缺少收银条码，无法发布到有赞门店");
  if (!hqSpuCode || !hqSkuCode) throw new Error("SKU 缺少有赞总部关系编码，无法发布到门店");
  if (branchKdtIds.length === 0) throw new Error("没有可发布的有赞分店");
  return {
    title: args.sku.name.trim(),
    categoryId: args.categoryId,
    unit: "件",
    priceYuan: args.sku.priceYuan,
    imageUrls: args.sku.imageUrls,
    spuCode: hqSpuCode,
    skuCenterCode: hqSkuCode,
    saleUpKdtIds: branchKdtIds,
    saleDownKdtIds: [],
    stock: {
      skuNo: scanCode,
      relatedSpuCode: hqSpuCode,
      relatedSkuCode: hqSkuCode,
      sellStockCount: Math.max(0, Math.trunc(args.stock)),
    },
  };
}

export function buildOfflineProductReleaseParams(input: OfflineProductReleaseInput) {
  if (!input.title.trim() || !input.spuCode.trim() || !input.skuCenterCode.trim()) {
    throw new Error("title and stable product codes are required");
  }
  if (input.imageUrls.length < 1 || input.imageUrls.length > 5) {
    throw new Error("Youzan release requires between one and five images");
  }
  const pictures = input.imageUrls.map((url) => ({ url }));
  const priceFen = String(Math.round(input.priceYuan * 100));
  return {
    join_level_discount: 1,
    measurement: 0,
    category_id: input.categoryId,
    unit: input.unit,
    sell_type: 1,
    price: priceFen,
    title: input.title,
    picture: JSON.stringify(pictures),
    spu_code: input.spuCode,
    sku_center_code: input.skuCenterCode,
    sub_kdt_status_param: {
      sale_up_kdt_ids: input.saleUpKdtIds,
      sale_down_kdt_ids: input.saleDownKdtIds,
    },
    all_batch_operate: -1,
    name: input.title,
    display: 1,
    retail_price: priceFen,
    photo_url: JSON.stringify(pictures),
    stocks: [
      {
        price: priceFen,
        cost_price: "0",
        sell_stock_count: String(Math.max(0, Math.trunc(input.stock.sellStockCount))),
        sku_no: input.stock.skuNo,
        related_spu_code: input.stock.relatedSpuCode,
        related_sku_code: input.stock.relatedSkuCode,
        is_sell: 1,
        min_retail_price: priceFen,
        max_retail_price: priceFen,
      },
    ],
  };
}

export function buildOfflineProductUpdateParams(input: OfflineProductReleaseInput, itemId: number) {
  if (!Number.isInteger(itemId) || itemId <= 0) {
    throw new Error("Youzan branch item id is required");
  }
  return {
    item_id: itemId,
    ...buildOfflineProductReleaseParams(input),
  };
}

export function buildCustomHqChannelUpdateParams(input: {
  spuId: number;
  name: string;
  spuCode: string;
  barcode: string;
  categoryId: number;
  priceYuan: number;
  kdtIds: number[];
  imageUrl?: string | null;
}) {
  const barcode = input.barcode.trim();
  if (!barcode) throw new Error("SKU 缺少 ERP 条码，无法同步有赞收银条码");
  const kdtIds = Array.from(new Set(input.kdtIds.filter((id) => Number.isInteger(id) && id > 0)));
  const params: Record<string, unknown> = {
    spu_id: input.spuId,
    name: input.name.trim(),
    spu_code: input.spuCode.trim(),
    spu_no: barcode,
    // `spu_no` is the primary scan barcode. Repeating it in `bar_codes`
    // makes Youzan reject the update as 商品更多条码重复.
    bar_codes: [],
    unit: "件",
    category_id: input.categoryId,
    retail_price: input.priceYuan.toFixed(2),
    sell_channel_setting_request: {
      // Custom products are unique pieces. Replace the full channel set so a
      // stale branch can never continue selling the same physical item.
      is_partial: 0,
      sell_channel_ids: kdtIds,
    },
  };
  if (input.imageUrl) {
    params.pic_url = input.imageUrl;
    params.spu_pic_list = [input.imageUrl];
    params.spu_img_list = [{ img_url: input.imageUrl }];
  }
  return params as typeof params & {
    spu_no: string;
    bar_codes: string[];
    sell_channel_setting_request: { is_partial: 0; sell_channel_ids: number[] };
  };
}

export async function queryYouzanOfflineProducts(args: {
  accessToken: string;
  input: OfflineProductQueryInput;
}): Promise<{ rows: OfflineProductRow[]; traceId: string | null }> {
  const { callYouzanApiVerbose } = await import("./youzan.functions");
  const result = await callYouzanApiVerbose({
    accessToken: args.accessToken,
    method: "youzan.retail.open.offline.spu.query",
    version: "3.0.0",
    params: buildOfflineProductQueryParams(args.input),
  });
  return { rows: parseOfflineProductRows(result.payload), traceId: result.trace_id };
}

export async function releaseYouzanOfflineProduct(args: {
  accessToken: string;
  input: OfflineProductReleaseInput;
}): Promise<{ itemId: number; skuIds: number[]; traceId: string | null }> {
  const { callYouzanApiVerbose } = await import("./youzan.functions");
  const result = await callYouzanApiVerbose({
    accessToken: args.accessToken,
    method: "youzan.retail.open.offline.spu.release",
    version: "3.0.0",
    params: buildOfflineProductReleaseParams(args.input),
    timeoutMs: 30_000,
  });
  const root = (
    result.payload && typeof result.payload === "object" ? result.payload : {}
  ) as Record<string, unknown>;
  const data = (root.data && typeof root.data === "object" ? root.data : root) as Record<
    string,
    unknown
  >;
  const itemId = Number(data.item_id ?? 0);
  const skuIds = Array.isArray(data.sku_ids)
    ? data.sku_ids.map(Number).filter((id) => Number.isFinite(id) && id > 0)
    : [];
  if (!itemId) throw new Error("Youzan release succeeded without item_id");
  return { itemId, skuIds, traceId: result.trace_id };
}

export async function updateYouzanOfflineProduct(args: {
  accessToken: string;
  itemId: number;
  input: OfflineProductReleaseInput;
}): Promise<{ traceId: string | null }> {
  const { callYouzanApiVerbose } = await import("./youzan.functions");
  const result = await callYouzanApiVerbose({
    accessToken: args.accessToken,
    method: "youzan.retail.open.offline.spu.update",
    version: "3.0.0",
    params: buildOfflineProductUpdateParams(args.input, args.itemId),
    timeoutMs: 30_000,
  });
  return { traceId: result.trace_id };
}

export async function cancelYouzanBranchOfflineChannel(args: {
  accessToken: string;
  branchKdtId: number;
  hqItemId: number;
}): Promise<{ traceId: string | null }> {
  const { callYouzanApiVerbose } = await import("./youzan.functions");
  const result = await callYouzanApiVerbose({
    accessToken: args.accessToken,
    method: "youzan.item.channel.cancel.publish",
    version: "1.0.0",
    params: buildCancelBranchChannelParams(args),
    timeoutMs: 30_000,
  });
  return { traceId: result.trace_id };
}

export async function resolveYouzanHqItemId(args: {
  accessToken: string;
  hqKdtId: number;
  itemCode: string;
}): Promise<{ itemId: number; traceId: string | null }> {
  if (!Number.isInteger(args.hqKdtId) || args.hqKdtId <= 0) {
    throw new Error("Youzan HQ kdt id is required");
  }
  if (!args.itemCode.trim()) throw new Error("Youzan HQ item code is required");
  const { callYouzanApiVerbose } = await import("./youzan.functions");
  const result = await callYouzanApiVerbose({
    accessToken: args.accessToken,
    method: "youzan.item.base.get",
    version: "1.0.0",
    params: {
      request: {
        kdt_id: args.hqKdtId,
        item_code: args.itemCode.trim(),
        channel: 0,
      },
    },
    timeoutMs: 30_000,
  });
  const itemId = pickYouzanHqItemId(result.payload);
  if (!itemId) throw new Error(`Youzan HQ item id not found for ${args.itemCode}`);
  return { itemId, traceId: result.trace_id };
}
