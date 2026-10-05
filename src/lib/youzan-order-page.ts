import { isYouzanSaleStatus } from "@/lib/youzan-sale-status";

export type OrderPageEntry<T> = {
  row: Record<string, unknown> & { kdt_id?: unknown; tid?: unknown };
  trade: T;
  targetShopId: string;
  status: string | null;
};

/**
 * 单页订单提交 + 库存对账。
 * - 队列切片（commitRows 存在）：只做租约校验后的原子订单提交，**不做库存销售处理**，
 *   避免补跑历史业绩触发新的库存扣减。
 * - 旧手动/全量同步（无 commitRows）：保持原行为——upsert 后对售出状态调用库存对账。
 */
export async function commitOrderPage<T>(input: {
  mapped: OrderPageEntry<T>[];
  commitRows?: (rows: Record<string, unknown>[]) => Promise<string[]>;
  upsertRows: (rows: Record<string, unknown>[]) => Promise<void>;
  processSale: (entry: OrderPageEntry<T>) => Promise<{
    processed: number;
    idempotent: number;
    unmatched: number;
    failed: number;
  }>;
}): Promise<{ upserted: number; processed: number; idempotent: number; unmatched: number; failed: number }> {
  const out = { upserted: 0, processed: 0, idempotent: 0, unmatched: 0, failed: 0 };
  const rows = input.mapped.map((e) => e.row);
  if (rows.length === 0) return out;
  if (input.commitRows) {
    const accepted = await input.commitRows(rows);
    out.upserted = new Set(accepted).size;
    return out; // order-only：不调用库存对账
  }
  await input.upsertRows(rows);
  out.upserted = rows.length;
  for (const entry of input.mapped) {
    if (!isYouzanSaleStatus(entry.status)) continue;
    try {
      const r = await input.processSale(entry);
      out.processed += r.processed;
      out.idempotent += r.idempotent;
      out.unmatched += r.unmatched;
      out.failed += r.failed;
    } catch (saleError) {
      out.failed += 1;
      console.error("[youzan-orders] 库存对账失败", saleError);
    }
  }
  return out;
}

