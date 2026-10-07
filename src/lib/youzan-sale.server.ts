export type YouzanSaleItem = {
  itemId: number;
  quantity: number;
  remoteSkuId: number | null;
  lookupCodes: string[];
  /** 有赞订单商品行 oid：稳定幂等键来源（行顺序变化不影响）。 */
  oid?: string;
  /** 行级退款状态（0=无退款）；缺省视为 0。 */
  refundState?: number;
};

export type YouzanSale = {
  tid: string;
  status: string | null;
  sourceChannel: "youzan_branch_offline" | "youzan_online";
  targetKdtId: number | null;
  items: YouzanSaleItem[];
};

export type YouzanSaleAdapter = {
  findLocationId(shopId: string, targetKdtId?: number | null): Promise<string | null>;
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
    /** 旧版按行下标生成的键；已按旧键扣过的单位不得再扣。 */
    legacySourceOrderId: string | null;
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
    const oidRaw = item.oid ?? item.order_item_id ?? item.orderItemId;
    const oid = oidRaw !== undefined && oidRaw !== null && /^[A-Za-z0-9_-]{1,64}$/.test(String(oidRaw)) ? String(oidRaw) : null;
    const lineRefund = Number(item.refund_state ?? item.item_refund_state ?? 0);
    const skuCodes = uniqueStrings([item.sku_no, item.skuNo, item.outer_sku_id, item.outerSkuId, item.sku_barcode, item.skuBarcode]);
    items.push({
      ...(oid ? { oid } : {}),
      ...(lineRefund ? { refundState: Number.isFinite(lineRefund) ? lineRefund : 1 } : {}),
      itemId,
      quantity,
      remoteSkuId,
      lookupCodes: skuCodes.length ? skuCodes : uniqueStrings([
        item.item_no,
        item.itemNo,
        item.outer_item_id,
        item.outerItemId,
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
  /** 可选逐单位闸门：返回 "commit" 才调用事务，否则按原因计数跳过（不写事件、不改库存）。 */
  gate?: (ctx: { lineIndex: number; unitIndex: number; item: YouzanSaleItem; skuId: string; locationId: string | null; sourceOrderId: string; legacyKey: string }) => Promise<string>;
}): Promise<{
  gated: Record<string, number>;
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
    gated: {} as Record<string, number>,
  };
  if (!isYouzanSaleStatus(sale.status)) return result;
  const root = asRecord(input.trade);
  const fullOrder = asRecord(root?.full_order_info) ?? asRecord(root?.fullOrderInfo) ?? root;
  const orderInfo = asRecord(fullOrder?.order_info) ?? asRecord(fullOrder?.orderInfo);
  if (Number(orderInfo?.refund_state ?? root?.refund_state ?? 0) !== 0) return result;
  const locationId = await input.adapter.findLocationId(input.shopId, sale.targetKdtId);
  if (sale.sourceChannel === "youzan_branch_offline" && !locationId) {
    throw new Error("销售门店未绑定库位，已停止库存扣减");
  }

  for (let lineIndex = 0; lineIndex < sale.items.length; lineIndex += 1) {
    const item = sale.items[lineIndex];
    if (item.refundState) {
      result.gated.lineRefunded = (result.gated.lineRefunded ?? 0) + item.quantity;
      continue;
    }
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
      const legacyKey = `${sale.tid}#${lineIndex}#${unitIndex}`;
      const sourceOrderId = item.oid ? `${sale.tid}#oid:${item.oid}#${unitIndex}` : legacyKey;
      if (input.gate) {
        const verdict = await input.gate({ lineIndex, unitIndex, item, skuId, locationId, sourceOrderId, legacyKey });
        if (verdict !== "commit") { result.gated[verdict] = (result.gated[verdict] ?? 0) + 1; continue; }
      }
      const committed = await input.adapter.commitSale({
        skuId,
        shopId: input.shopId,
        locationId,
        sourceChannel: sale.sourceChannel,
        sourceOrderId,
        legacySourceOrderId: item.oid ? legacyKey : null,
        rawPayload: {
          tid: sale.tid,
          item_id: item.itemId,
          remote_sku_id: item.remoteSkuId,
          quantity: item.quantity,
          line_index: lineIndex,
          oid: item.oid ?? null,
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
