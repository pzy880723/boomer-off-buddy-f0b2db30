/**
 * 有界近期有赞真实销售补偿（只补库存 tracked 的自定义 single 孤品）：
 * - 订单队列是 order-only（防 30 天历史导入误扣）；本作业只扫最近 ≤72h 且不早于 floor 的已付款订单，
 *   按 (pay_time, tid) 键集分页推进，扫完整个窗口（有总量上限），已完成订单不会占满批次导致后续饥饿。
 * - 完结判定逐件：只有 status=processed 的事件（新 oid 键或旧下标键）才算已扣；oversold/unmatched 不算，下次可重试。
 * - 标准品（unlimited/standard）、非 single、无门店库位、门店无库存、销售后该门店有入库（跨库存版本）、
 *   整单或行级退款 → 跳过，不写事件、不改库存。扣减只走 commit_youzan_sale_line → commit_sale 原事务。
 * - 过滤不改变行下标与 oid，旧键保持不变。
 */
import { extractYouzanSale, isYouzanSaleStatus, processYouzanSale, type YouzanSaleAdapter } from "./youzan-sale.server";

export const SALE_COMPENSATION_FLOOR = "2026-10-05T13:00:00.000Z";
export const MAX_WINDOW_HOURS = 72;
export const PAGE_SIZE = 100;
export const MAX_ORDERS_PER_RUN = 3000;

export type CandidateOrder = { tid: string; shop_id: string; status: string | null; pay_time: string; raw: unknown };
export type SkuMeta = { scope: string | null; kind: string | null; policy: string | null; salesState: string | null };
export type CompensationDeps = {
  listOrdersPage(q: { since: string; limit: number; after?: { pay_time: string; tid: string }; tids?: string[] }): Promise<CandidateOrder[]>;
  /** 只返回 status=processed 的 paid 事件键。 */
  processedKeys(tids: string[]): Promise<Set<string>>;
  skuMeta(skuIds: string[]): Promise<Map<string, SkuMeta>>;
  locationQty(skuId: string, locationId: string): Promise<number>;
  /** 该门店在 since 之后是否有正向入库（库存版本已变化，旧销售不得扣新货）。 */
  restockedAfter(skuId: string, locationId: string, since: string): Promise<boolean>;
  adapter(): YouzanSaleAdapter;
};
export type PlannedLine = { tid: string; sourceOrderId: string; skuId: string; locationId: string | null };

function refundState(raw: unknown): number {
  const v = (raw as { full_order_info?: { order_info?: { refund_state?: unknown } } })?.full_order_info?.order_info?.refund_state;
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 1;
}

export function isCompensableSku(m: SkuMeta | undefined): boolean {
  return !!m && m.scope === "custom" && m.kind === "single" && m.policy === "tracked";
}

export async function compensateRecentYouzanSales(d: CompensationDeps, opts: {
  now?: Date; windowHours?: number; limit?: number; dryRun?: boolean; tids?: string[];
} = {}) {
  const now = opts.now ?? new Date();
  const hours = Math.max(1, Math.min(opts.windowHours ?? 48, MAX_WINDOW_HOURS));
  const since = new Date(Math.max(now.getTime() - hours * 3600_000, Date.parse(SALE_COMPENSATION_FLOOR))).toISOString();
  const pageSize = Math.max(1, Math.min(opts.limit ?? PAGE_SIZE, 500));
  const out = {
    since, scanned: 0, truncated: false, skipped: 0, already: 0, committed: 0, idempotent: 0, unmatched: 0, failed: 0,
    notCustom: 0, noLocation: 0, noStock: 0, versionConflict: 0, lineRefunded: 0, planned: [] as PlannedLine[],
  };
  const metaCache = new Map<string, SkuMeta | undefined>();
  let after: { pay_time: string; tid: string } | undefined;

  for (;;) {
    const rows = await d.listOrdersPage({ since, limit: pageSize, ...(after ? { after } : {}), ...(opts.tids?.length ? { tids: opts.tids } : {}) });
    if (rows.length === 0) break;
    const processed = await d.processedKeys(rows.map((r) => r.tid));
    for (const row of rows) {
      out.scanned++;
      const sale = extractYouzanSale(row.raw);
      if (!sale || !isYouzanSaleStatus(row.status) || !isYouzanSaleStatus(sale.status) || refundState(row.raw) !== 0) { out.skipped++; continue; }
      let pending = 0;
      const base = d.adapter();
      if (!(await base.findLocationId(row.shop_id))) {
        out.noLocation += sale.items.reduce((n, i) => n + i.quantity, 0);
        continue;
      }
      const adapter: YouzanSaleAdapter = opts.dryRun
        ? { ...base, commitSale: async (i) => { out.planned.push({ tid: row.tid, sourceOrderId: i.sourceOrderId, skuId: i.skuId, locationId: i.locationId }); return { ok: true, idempotent: true }; } }
        : base;
      try {
        const r = await processYouzanSale({
          trade: row.raw, shopId: row.shop_id, adapter,
          gate: async ({ item, skuId, locationId, sourceOrderId, legacyKey }) => {
            if (processed.has(sourceOrderId) || processed.has(legacyKey)) return "already";
            if (item.refundState) return "lineRefunded";
            if (!metaCache.has(skuId)) metaCache.set(skuId, (await d.skuMeta([skuId])).get(skuId));
            const meta = metaCache.get(skuId);
            if (!isCompensableSku(meta)) return "notCustom";
            if (!locationId) return "noLocation";
            if (await d.restockedAfter(skuId, locationId, row.pay_time)) return "versionConflict";
            if ((await d.locationQty(skuId, locationId)) < 1) return "noStock";
            pending++;
            return "commit";
          },
        });
        for (const k of ["notCustom", "noLocation", "noStock", "versionConflict", "lineRefunded"] as const) out[k] += r.gated[k] ?? 0;
        if (!opts.dryRun) { out.committed += r.processed - r.idempotent; out.idempotent += r.idempotent; }
        out.failed += r.failed;
        out.unmatched += r.unmatched;
        const total = Object.values(r.gated).reduce((a, b) => a + b, 0) + r.unmatched + r.processed + r.failed;
        if (pending === 0 && r.failed === 0 && total > 0 && (r.gated.already ?? 0) === total) out.already++;
      } catch {
        out.failed++;
      }
    }
    const last = rows[rows.length - 1];
    after = { pay_time: last.pay_time, tid: last.tid };
    if (rows.length < pageSize) break;
    if (out.scanned >= MAX_ORDERS_PER_RUN) { out.truncated = true; break; }
  }
  return out;
}
