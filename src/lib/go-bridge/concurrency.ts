/** 有限并发 map：保持输入顺序，任意时刻最多 limit 个任务在跑。 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export type PageResult<T> = { data: T[] | null; error: { message: string } | null };

/**
 * 完整分页读取：按 [from, to] 区间逐页拉取，直到某页不满。
 * 任一页出错即抛出（绝不把部分结果当成完整结果）；超出 maxRows 也抛出。
 */
export async function fetchAllPages<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 1000;
  const maxRows = opts.maxRows ?? 50_000;
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (all.length > maxRows) throw new Error("row_limit_exceeded");
    if (rows.length < pageSize) return all;
  }
}

/** 有赞订单当日付款毛额：整数分、tid 去重、排除 TRADE_CLOSED；非法金额抛错不当 0。 */
export function sumYouzanPaid(
  rows: readonly { tid?: string | null; status: string | null; payment: unknown; total_fee: unknown }[],
): { fen: number; orders: number } {
  const seen = new Set<string>();
  let fen = 0;
  let orders = 0;
  for (const r of rows) {
    if (String(r.status ?? "").toUpperCase() === "TRADE_CLOSED") continue;
    if (r.tid) {
      if (seen.has(r.tid)) continue;
      seen.add(r.tid);
    }
    const raw = r.payment ?? r.total_fee ?? 0;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error("youzan_amount_invalid");
    fen += Math.round(n * 100);
    orders += 1;
  }
  return { fen, orders };
}
