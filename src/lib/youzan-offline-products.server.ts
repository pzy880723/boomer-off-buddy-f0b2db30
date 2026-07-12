export type OfflineProductQueryInput = {
  pageNo?: number;
  pageSize?: number;
  displayStatus?: 0 | 1 | 2;
  warehouseCode?: string;
  nameOrSkuNo?: string;
  itemIds?: number[];
};

export function buildOfflineProductQueryParams(input: OfflineProductQueryInput) {
  const pageNo = input.pageNo ?? 1;
  const pageSize = input.pageSize ?? 20;
  if (!Number.isInteger(pageNo) || pageNo < 1) throw new Error("pageNo must be positive");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error("pageSize must be between 1 and 100");
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

export function buildOfflineProductReleaseParams(input: OfflineProductReleaseInput) {
  if (!input.title.trim() || !input.spuCode.trim() || !input.skuCenterCode.trim()) {
    throw new Error("title and stable product codes are required");
  }
  if (input.imageUrls.length < 1 || input.imageUrls.length > 5) {
    throw new Error("Youzan release requires between one and five images");
  }
  const pictures = input.imageUrls.map((url) => ({ url }));
  return {
    join_level_discount: 1,
    measurement: 0,
    category_id: input.categoryId,
    unit: input.unit,
    sell_type: 1,
    price: String(input.priceYuan),
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
    retail_price: String(input.priceYuan),
    photo_url: JSON.stringify(pictures),
    stocks: [
      {
        price: String(Math.round(input.priceYuan * 100)),
        cost_price: "0",
        sell_stock_count: String(Math.max(0, Math.trunc(input.stock.sellStockCount))),
        sku_no: input.stock.skuNo,
        related_spu_code: input.stock.relatedSpuCode,
        related_sku_code: input.stock.relatedSkuCode,
        is_sell: 1,
        min_retail_price: String(Math.round(input.priceYuan * 100)),
        max_retail_price: String(Math.round(input.priceYuan * 100)),
      },
    ],
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
