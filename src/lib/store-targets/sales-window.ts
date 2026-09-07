/**
 * 销售日汇总口径（纯函数，可单测）。
 *
 * 关键规则：
 *  - 「日」一律为 Asia/Shanghai 自然日（UTC+8，无夏令时），窗口 [date 00:00+08, 次日 00:00+08)。
 *  - 有赞侧统计的是「已付款毛额」，不是净销售：本地没有退款数据源，
 *    因此结果必须标记 incomplete，禁止对外声称净销售。
 *  - 不能只用 TRADE_SUCCESS：待发货 / 待成团 / 已发货等已付款状态同样算业绩，
 *    只排除明确未付款或已关闭的状态。
 *  - 线下补录与有赞金额分别返回，前端/接口不得把两者的同一笔重复相加，
 *    补录侧靠凭证与 youzan_exclusion_basis 承担排除责任。
 */

export const SHANGHAI_UTC_OFFSET_MINUTES = 8 * 60;

/** 把 Asia/Shanghai 自然日转换成 UTC 时间窗口 [start, end) 的 ISO 字符串 */
export function shanghaiDayWindow(date: string): { startUtc: string; endUtc: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`日期格式必须是 yyyy-mm-dd，收到：${date}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const startMs = Date.UTC(y, mo - 1, d) - SHANGHAI_UTC_OFFSET_MINUTES * 60_000;
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return { startUtc: new Date(startMs).toISOString(), endUtc: new Date(endMs).toISOString() };
}

/** 当前时刻对应的 Asia/Shanghai 自然日 */
export function shanghaiToday(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + SHANGHAI_UTC_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** Asia/Shanghai 自然日所属月份 yyyy-mm */
export function shanghaiMonthOf(date: string): string {
  return date.slice(0, 7);
}

/** 明确「未付款 / 已关闭」的有赞交易状态：这些不计入业绩 */
export const YOUZAN_NON_PAID_STATUSES = new Set([
  "WAIT_BUYER_PAY",
  "TRADE_NO_CREATE_PAY",
  "TRADE_CLOSED",
  "TRADE_CLOSED_BY_TAOBAO",
  "TRADE_CLOSED_BY_USER",
  "TRADE_CLOSED_BY_SYSTEM",
  "TRADE_EXPIRED",
]);

export type YouzanOrderRow = {
  status: string | null;
  pay_time: string | null;
  payment: number | string | null;
  total_fee: number | string | null;
  post_fee: number | string | null;
};

/**
 * 判定一笔有赞订单是否计入当日已付款毛额。
 * 判定基础是「有 pay_time」+「状态不在明确未付款/关闭集合内」，
 * 而不是白名单 TRADE_SUCCESS，避免漏掉待发货等已付款订单。
 */
export function isYouzanPaidOrder(row: YouzanOrderRow): boolean {
  if (!row.pay_time) return false;
  const status = (row.status ?? "").toUpperCase();
  if (!status) return true;
  return !YOUZAN_NON_PAID_STATUSES.has(status);
}

export function toFen(value: number | string | null | undefined): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export type YouzanDayAggregate = {
  gross_paid_fen: number;
  shipping_fee_fen: number;
  /** 业绩口径 = 已付款毛额 - 运费 */
  performance_fen: number;
  order_count: number;
  excluded_order_count: number;
};

export function aggregateYouzanDay(rows: YouzanOrderRow[]): YouzanDayAggregate {
  let gross = 0;
  let shipping = 0;
  let count = 0;
  let excluded = 0;
  for (const row of rows) {
    if (!isYouzanPaidOrder(row)) {
      excluded += 1;
      continue;
    }
    const paid = row.payment != null ? toFen(row.payment) : toFen(row.total_fee);
    gross += paid;
    shipping += toFen(row.post_fee);
    count += 1;
  }
  return {
    gross_paid_fen: gross,
    shipping_fee_fen: shipping,
    performance_fen: gross - shipping,
    order_count: count,
    excluded_order_count: excluded,
  };
}

export type CompletenessInput = {
  /** 有赞订单最近一次成功同步入库时间（UTC ISO），null 表示从未同步 */
  youzanLastSyncedAt: string | null;
  /** 统计窗口结束时间（UTC ISO） */
  windowEndUtc: string;
  /** 是否存在有赞退款数据源 */
  hasRefundSource: boolean;
  /** 允许的同步延迟（分钟） */
  freshnessToleranceMinutes?: number;
  now?: Date;
};

export type Completeness = {
  complete: boolean;
  /** 对外必须展示的口径标签 */
  basis: "paid_gross_minus_shipping";
  reasons: string[];
  youzan_synced_through: string | null;
  refund_source: "unavailable" | "available";
};

/**
 * 只要同步落后于统计窗口，或没有退款数据源，都必须判定为 incomplete。
 * 禁止在此处静默返回 0 或谎称净销售。
 */
export function evaluateCompleteness(input: CompletenessInput): Completeness {
  const tolerance = (input.freshnessToleranceMinutes ?? 60) * 60_000;
  const reasons: string[] = [];

  const windowEnd = Date.parse(input.windowEndUtc);
  const now = (input.now ?? new Date()).getTime();
  const effectiveEnd = Math.min(windowEnd, now);

  if (!input.youzanLastSyncedAt) {
    reasons.push("youzan_never_synced");
  } else {
    const synced = Date.parse(input.youzanLastSyncedAt);
    if (Number.isNaN(synced)) {
      reasons.push("youzan_sync_timestamp_invalid");
    } else if (synced + tolerance < effectiveEnd) {
      reasons.push("youzan_sync_stale");
    }
  }
  if (!input.hasRefundSource) reasons.push("refund_data_unavailable");

  return {
    complete: reasons.length === 0,
    basis: "paid_gross_minus_shipping",
    reasons,
    youzan_synced_through: input.youzanLastSyncedAt,
    refund_source: input.hasRefundSource ? "available" : "unavailable",
  };
}

export type DailyProgressInput = {
  targetFen: number | null;
  youzanPerformanceFen: number;
  offlineFen: number;
};

export type DailyProgress = {
  target_fen: number | null;
  achieved_fen: number;
  gap_fen: number | null;
  progress_pct: number | null;
};

export function computeDailyProgress(input: DailyProgressInput): DailyProgress {
  const achieved = input.youzanPerformanceFen + input.offlineFen;
  if (input.targetFen == null) {
    return { target_fen: null, achieved_fen: achieved, gap_fen: null, progress_pct: null };
  }
  const gap = input.targetFen - achieved;
  const pct = input.targetFen > 0 ? Math.round((achieved / input.targetFen) * 10000) / 100 : null;
  return { target_fen: input.targetFen, achieved_fen: achieved, gap_fen: gap, progress_pct: pct };
}
