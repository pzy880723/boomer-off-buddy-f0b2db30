export function buildYouzanQuantityUpdateParams(args: {
  kdtId: number;
  itemId: number;
  skuId: number;
  quantity: number;
  channel: 0 | 1;
}): Record<string, unknown> {
  return {
    param: {
      kdtId: args.kdtId,
      kdt_id: args.kdtId,
      item_id: args.itemId,
      sku_id: args.skuId,
      channel: args.channel,
      stock_num: Math.max(0, Math.floor(args.quantity)),
    },
  };
}

export function assertYouzanStockWriteSucceeded(payload: unknown) {
  const result = payload as { success?: boolean; message?: string } | null;
  if (payload === false || result?.success === false) {
    throw new Error(result?.message || "有赞库存更新未生效");
  }
}

export function buildWarehouseStockAdjustment(args: {
  warehouseCode: string; skuCode: string; quantity: number; operationId: string; createTime: string;
}) {
  if (!args.warehouseCode || !args.skuCode || !Number.isInteger(args.quantity) || args.quantity < 0) {
    throw new Error("仓库编码、规格编码或库存数量无效");
  }
  return {
    warehouse_code: args.warehouseCode,
    source_order_no: args.operationId,
    create_time: args.createTime,
    creator: "BOOMER ERP", remark: "按ERP对应库位同步绝对库存",
    // Omitting operate_type means an absolute quantity, not another inbound.
    order_items: [{ sku_code: args.skuCode, quantity: String(args.quantity) }],
  };
}

export function selectTrustedBranchItemIds(args: {
  linkItemId: number | null | undefined;
  linkSkuId: number | null | undefined;
  hqSpuId: number;
}): { item_id: number; sku_id: number } | null {
  const itemId = Number(args.linkItemId ?? 0);
  const skuId = Number(args.linkSkuId ?? itemId);

  if (itemId <= 0 || skuId <= 0 || itemId === args.hqSpuId) return null;
  return { item_id: itemId, sku_id: skuId };
}
