/**
 * 销售仪表盘纯逻辑层（可单测，不访问数据库）。
 *
 * 口径铁律：
 *  - 「日」一律 Asia/Shanghai 自然日，自选区间最多 93 天。
 *  - 净销售 = 已支付金额 − 成功退款；没有可靠退款来源的渠道返回 null + warning，禁止造 0。
 *  - 任何异常都不能吞成 0：调用方必须把失败转成 warning + null。
 */
import { shanghaiToday } from "@/lib/store-targets/sales-window";

export const MAX_CUSTOM_RANGE_DAYS = 93;
export const TREND_DAYS = 7;

export type RangeKey = "today" | "yesterday" | "month" | "custom";
export type ChannelKey = "pos" | "storefront" | "youzan";
export type WarningScope = "metrics" | "channel" | "trend" | "todo";

export type ResolvedRange = {
  key: RangeKey;
  start: string;
  end: string;
  days: number;
  timezone: "Asia/Shanghai";
};

export type DashboardWarning = { code: string; message: string; scope: WarningScope };

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDate(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`日期格式必须是 yyyy-mm-dd，收到：${date}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(ms).toISOString().slice(0, 10);
  if (back !== date) throw new Error(`日期不存在：${date}`);
  return ms;
}

export function addDays(date: string, delta: number): string {
  return new Date(parseDate(date) + delta * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetweenInclusive(start: string, end: string): number {
  return Math.round((parseDate(end) - parseDate(start)) / DAY_MS) + 1;
}

export function resolveRange(
  input: { range: RangeKey; start?: string; end?: string },
  now: Date = new Date(),
): ResolvedRange {
  const today = shanghaiToday(now);
  let start: string;
  let end: string;

  switch (input.range) {
    case "today":
      start = today;
      end = today;
      break;
    case "yesterday":
      start = addDays(today, -1);
      end = start;
      break;
    case "month":
      start = `${today.slice(0, 7)}-01`;
      end = today;
      break;
    case "custom": {
      if (!input.start || !input.end) throw new Error("自选区间必须同时提供 start 与 end");
      start = input.start;
      end = input.end;
      if (parseDate(start) > parseDate(end)) throw new Error("start 不能晚于 end");
      const days = daysBetweenInclusive(start, end);
      if (days > MAX_CUSTOM_RANGE_DAYS) {
        throw new Error(`自选区间最多 ${MAX_CUSTOM_RANGE_DAYS} 天，收到 ${days} 天`);
      }
      break;
    }
    default:
      throw new Error(`不支持的区间：${String(input.range)}`);
  }

  parseDate(start);
  parseDate(end);
  return {
    key: input.range,
    start,
    end,
    days: daysBetweenInclusive(start, end),
    timezone: "Asia/Shanghai",
  };
}

/** 趋势窗口：固定 7 天，止于所选结束日期 */
export function trendWindow(end: string): { start: string; dates: string[] } {
  const start = addDays(end, -(TREND_DAYS - 1));
  const dates: string[] = [];
  for (let i = 0; i < TREND_DAYS; i += 1) dates.push(addDays(start, i));
  return { start, dates };
}

/** 缺失即 null，绝不退化成 0 */
export function sumMoney(values: Array<number | null>): number | null {
  if (values.some((v) => v == null)) return null;
  return values.reduce<number>((s, v) => s + (v as number), 0);
}

export function avgOrderValueFen(
  netSalesFen: number | null,
  orderCount: number | null,
): number | null {
  if (netSalesFen == null || orderCount == null || orderCount <= 0) return null;
  return Math.round(netSalesFen / orderCount);
}

export type ChannelRefundState = { key: ChannelKey; refundSource: "available" | "unavailable" };

export function refundWarnings(channels: ChannelRefundState[]): DashboardWarning[] {
  return channels
    .filter((c) => c.refundSource === "unavailable")
    .map((c) => ({
      code: `refund_source_unavailable:${c.key}`,
      message: `渠道 ${c.key} 没有可用的退款数据源，其净销售为「未扣除退款」口径，请勿视为已扣退款的准确值`,
      scope: "channel" as const,
    }));
}

export type SourceFreshness = {
  key: ChannelKey;
  lastSyncedAt: string | null;
  staleToleranceMinutes?: number;
};

/** 同步水位落后于窗口结束时间即判定 stale；从未同步同样 stale */
export function evaluateSourceStale(
  source: SourceFreshness,
  windowEndUtc: string,
  now: Date = new Date(),
): boolean {
  if (!source.lastSyncedAt) return true;
  const synced = Date.parse(source.lastSyncedAt);
  if (Number.isNaN(synced)) return true;
  const tolerance = (source.staleToleranceMinutes ?? 60) * 60_000;
  const effectiveEnd = Math.min(Date.parse(windowEndUtc), now.getTime());
  return synced + tolerance < effectiveEnd;
}

export type LocationScopeInput = {
  requested: string | "all" | undefined;
  isHq: boolean;
  allowedLocationIds: string[];
};

export type LocationScope = {
  mode: "all" | "single";
  locationId: string | null;
  locationIds: string[];
  /** HQ 查看全部时，纳入没有归属门店的线上订单 */
  includeUnassigned: boolean;
};

export function resolveLocationScope(input: LocationScopeInput): LocationScope {
  const requested = input.requested;
  if (!requested || requested === "all") {
    if (input.isHq) {
      return {
        mode: "all",
        locationId: null,
        locationIds: input.allowedLocationIds,
        includeUnassigned: true,
      };
    }
    if (input.allowedLocationIds.length === 0) throw new Error("当前账号没有被授权任何门店");
    if (input.allowedLocationIds.length === 1) {
      return {
        mode: "single",
        locationId: input.allowedLocationIds[0],
        locationIds: input.allowedLocationIds,
        includeUnassigned: false,
      };
    }
    return {
      mode: "all",
      locationId: null,
      locationIds: input.allowedLocationIds,
      includeUnassigned: false,
    };
  }
  if (!input.isHq && !input.allowedLocationIds.includes(requested)) {
    throw new Error("无权查看该门店数据");
  }
  return {
    mode: "single",
    locationId: requested,
    locationIds: [requested],
    includeUnassigned: false,
  };
}
