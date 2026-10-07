/**
 * 有界近期有赞真实销售补偿：
 * - 订单队列是 order-only（防止 30 天历史导入误扣），推送可能丢失或验签失败；
 *   本作业只扫描最近 ≤72 小时、且不早于 SALE_COMPENSATION_FLOOR 的已付款订单，
 *   用 youzan_orders.raw（不调用有赞接口）按稳定 oid 键走 commit_youzan_sale_line。
 * - 已退款/关闭订单跳过：退款不自动复活库存，也不扣减。
 * - 失败不记状态，下次运行按幂等键自然重试。
 */
import { extractYouzanSale, isYouzanSaleStatus, processYouzanSale, type YouzanSaleAdapter } from "./youzan-sale.server";

/** 旧全量同步最后一次真实扣减在此之后停止；更早订单已由旧链路处理或属历史导入。 */
export const SALE_COMPENSATION_FLOOR = "2026-10-05T13:00:00.000Z";
export const MAX_WINDOW_HOURS = 72;

export type CandidateOrder = { tid: string; shop_id: string; status: string | null; pay_time: string; raw: unknown };
export type CompensationDeps = {
  listOrders(q: { since: string; limit: number; tids?: string[] }): Promise<CandidateOrder[]>;
  /** tid → 已存在的 paid 销售事件数（任意状态，含 oversold）。 */
  committedUnits(tids: string[]): Promise<Record<string, number>>;
  adapter(): YouzanSaleAdapter;
};
export type PlannedLine = { tid: string; sourceOrderId: string; skuId: string; locationId: string | null };

function refundState(raw: unknown): number {
  const v = (raw as { full_order_info?: { order_info?: { refund_state?: unknown } } })?.full_order_info?.order_info?.refund_state;
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 1;
}

export async function compensateRecentYouzanSales(d: CompensationDeps, opts: {
  now?: Date; windowHours?: number; limit?: number; dryRun?: boolean; /** 定点补偿：仍受时间窗与 floor 约束。 */ tids?: string[];
} = {}) {
  const now = opts.now ?? new Date();
  const hours = Math.max(1, Math.min(opts.windowHours ?? 48, MAX_WINDOW_HOURS));
  const since = new Date(Math.max(now.getTime() - hours * 3600_000, Date.parse(SALE_COMPENSATION_FLOOR))).toISOString();
  const rows = await d.listOrders({ since, limit: Math.max(1, Math.min(opts.limit ?? 200, 500)), ...(opts.tids?.length ? { tids: opts.tids } : {}) });
  const done = await d.committedUnits(rows.map((r) => r.tid));
  const out = { since, scanned: rows.length, skipped: 0, already: 0, committed: 0, idempotent: 0, unmatched: 0, failed: 0, planned: [] as PlannedLine[] };
  for (const row of rows) {
    const sale = extractYouzanSale(row.raw);
    if (!sale || !isYouzanSaleStatus(row.status) || !isYouzanSaleStatus(sale.status) || refundState(row.raw) !== 0) { out.skipped++; continue; }
    const units = sale.items.reduce((s, i) => s + i.quantity, 0);
    if (units > 0 && (done[row.tid] ?? 0) >= units) { out.already++; continue; }
    const base = d.adapter();
    const adapter: YouzanSaleAdapter = opts.dryRun
      ? { ...base, commitSale: async (i) => { out.planned.push({ tid: row.tid, sourceOrderId: i.sourceOrderId, skuId: i.skuId, locationId: i.locationId }); return { ok: true, idempotent: true }; } }
      : base;
    try {
      const r = await processYouzanSale({ trade: row.raw, shopId: row.shop_id, adapter });
      if (!opts.dryRun) { out.committed += r.processed - r.idempotent; out.idempotent += r.idempotent; }
      out.unmatched += r.unmatched;
      out.failed += r.failed;
    } catch {
      out.failed++;
    }
  }
  return out;
}
