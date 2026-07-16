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
