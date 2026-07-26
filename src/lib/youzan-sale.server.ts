export type YouzanSaleItem = {
  itemId: number;
  quantity: number;
  remoteSkuId: number | null;
  lookupCodes: string[];
};

export type YouzanSale = {
  tid: string;
  status: string | null;
  sourceChannel: "youzan_branch_offline" | "youzan_online";
  targetKdtId: number | null;
  items: YouzanSaleItem[];
};

export type YouzanSaleAdapter = {
  findLocationId(shopId: string): Promise<string | null>;
  findSkuId(input: {
    shopId: string;
    itemId: number;
    remoteSkuId: number | null;
    lookupCodes: string[];
  }): Promise<string | null>;
  commitSale(input: {
    skuId: string;
    shopId: string;
    locationId: string | null;
    sourceChannel: YouzanSale["sourceChannel"];
    sourceOrderId: string;
    rawPayload: Record<string, unknown>;
  }): Promise<{ ok: boolean; idempotent?: boolean; error?: string }>;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function firstString(records: Array<UnknownRecord | null>, keys: string[]): string {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (value !== undefined && value !== null && String(value).trim()) {
        return String(value).trim();
      }
    }
  }
  return "";
}

function uniqueStrings(values: unknown[]): string[] {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

export function isYouzanSaleStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return [
    "TRADE_PAID",
    "TRADE_SUCCESS",
    "WAIT_SELLER_SEND_GOODS",
    "WAIT_BUYER_CONFIRM_GOODS",
  ].includes(status.toUpperCase());
}

export function extractYouzanSale(trade: unknown): YouzanSale | null {
  const root = asRecord(trade);
  if (!root) return null;
  const fullOrder = asRecord(root.full_order_info) ?? asRecord(root.fullOrderInfo) ?? root;
  const orderInfo = asRecord(fullOrder.order_info) ?? asRecord(fullOrder.orderInfo);
  const sourceInfo = asRecord(fullOrder.source_info) ?? asRecord(fullOrder.sourceInfo);
  const nestedTrade = asRecord(root.trade);
  const nestedData = asRecord(root.data);

  const tid = firstString(
    [root, orderInfo, nestedTrade, nestedData],
    ["tid", "order_no", "orderNo", "biz_order_id", "bizOrderId"],
  );
  if (!tid) return null;

  const status =
    firstString(
      [root, orderInfo, nestedTrade, nestedData],
      ["status", "trade_status", "tradeStatus", "order_status", "orderStatus"],
    ) || null;
  const isOffline =
    sourceInfo?.is_offline_order === true ||
    sourceInfo?.isOfflineOrder === true ||
    String(sourceInfo?.is_offline_order ?? sourceInfo?.isOfflineOrder ?? "").toLowerCase() ===
      "true";
  const targetKdtId =
    Number(
      (isOffline
        ? (orderInfo?.offline_id ?? orderInfo?.offlineId)
        : (orderInfo?.node_kdt_id ?? orderInfo?.nodeKdtId ?? orderInfo?.offline_id)) ?? 0,
    ) || null;

  const candidates = [fullOrder.orders, root.orders, nestedTrade?.orders, nestedData?.orders];
  let rows: unknown[] = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      rows = candidate;
      break;
    }
  }

  const items: YouzanSaleItem[] = [];
  for (const row of rows) {
    const item = asRecord(row);
    if (!item) continue;
    const itemId = Number(item.item_id ?? item.itemId ?? item.num_iid ?? item.numIid ?? 0);
    const quantity = Math.max(0, Math.trunc(Number(item.num ?? item.quantity ?? item.count ?? 0)));
    if (!Number.isFinite(itemId) || itemId <= 0 || quantity <= 0) continue;
    const remoteSkuId = Number(item.sku_id ?? item.skuId ?? 0) || null;
    items.push({
      itemId,
      quantity,
      remoteSkuId,
      lookupCodes: uniqueStrings([
        item.sku_no,
        item.skuNo,
        item.outer_sku_id,
        item.outerSkuId,
        item.item_no,
        item.itemNo,
        item.outer_item_id,
        item.outerItemId,
        item.sku_barcode,
        item.skuBarcode,
        item.item_barcode,
        item.itemBarcode,
      ]),
    });
  }

  return {
    tid,
    status,
    sourceChannel: isOffline ? "youzan_branch_offline" : "youzan_online",
    targetKdtId,
    items,
  };
}

export async function processYouzanSale(input: {
  trade: unknown;
  shopId: string;
  adapter: YouzanSaleAdapter;
}): Promise<{
  tid: string;
  processed: number;
  idempotent: number;
  unmatched: number;
  failed: number;
}> {
  const sale = extractYouzanSale(input.trade);
  if (!sale) throw new Error("有赞订单缺少 tid");
  const result = {
    tid: sale.tid,
    processed: 0,
    idempotent: 0,
    unmatched: 0,
    failed: 0,
  };
  const locationId = await input.adapter.findLocationId(input.shopId);

  for (let lineIndex = 0; lineIndex < sale.items.length; lineIndex += 1) {
    const item = sale.items[lineIndex];
    const skuId = await input.adapter.findSkuId({
      shopId: input.shopId,
      itemId: item.itemId,
      remoteSkuId: item.remoteSkuId,
      lookupCodes: item.lookupCodes,
    });
    if (!skuId) {
      result.unmatched += item.quantity;
      continue;
    }

    for (let unitIndex = 0; unitIndex < item.quantity; unitIndex += 1) {
      const sourceOrderId = `${sale.tid}#${lineIndex}#${unitIndex}`;
      const committed = await input.adapter.commitSale({
        skuId,
        shopId: input.shopId,
        locationId,
        sourceChannel: sale.sourceChannel,
        sourceOrderId,
        rawPayload: {
          tid: sale.tid,
          item_id: item.itemId,
          remote_sku_id: item.remoteSkuId,
          quantity: item.quantity,
          line_index: lineIndex,
          unit_index: unitIndex,
        },
      });
      if (committed.ok) {
        result.processed += 1;
        if (committed.idempotent) result.idempotent += 1;
      } else {
        result.failed += 1;
      }
    }
  }

  return result;
}
