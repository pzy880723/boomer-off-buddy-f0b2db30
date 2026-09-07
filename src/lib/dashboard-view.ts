export type DashboardRange = { start: string; end: string };
export type DashboardPeriod = "today" | "yesterday" | "month";
const DAY = 86_400_000;

export function dashboardRange(period: DashboardPeriod, now = new Date()): DashboardRange {
  const today = new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
  const end =
    period === "yesterday" ? new Date(Date.parse(today) - DAY).toISOString().slice(0, 10) : today;
  return { start: period === "month" ? `${today.slice(0, 7)}-01` : end, end };
}

export function validateDashboardRange(range: DashboardRange): string | null {
  for (const value of [range.start, range.end]) {
    const parsed = Date.parse(value);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(parsed) ||
      new Date(parsed).toISOString().slice(0, 10) !== value
    )
      return "请选择有效的开始和结束日期";
  }
  const days = (Date.parse(range.end) - Date.parse(range.start)) / DAY + 1;
  if (days < 1) return "结束日期不能早于开始日期";
  if (days > 93) return "一次最多查看 93 天，请缩短日期范围";
  return null;
}

export function displayAmount(fen: number | null): string {
  if (fen === null || !Number.isFinite(fen)) return "待核对";
  return `${fen < 0 ? "-" : ""}¥${(Math.abs(fen) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function displayCount(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "待核对" : value.toLocaleString("zh-CN");
}

export type DashboardDisplay = {
  scopeLabel: string;
  fetchedAt: string;
  metrics: {
    netSalesFen: number | null;
    grossPaidFen: number;
    orders: number;
    units: number | null;
    aovFen: number | null;
  };
  channels: Array<{ key: string; label: string; netSalesFen: number | null; grossPaidFen: number }>;
  trend: Array<{ date: string; netSalesFen: number | null; grossPaidFen: number }>;
  tasks: Array<{ key: string; label: string; count: number | null; href: string }>;
  warnings: string[];
  isHq: boolean;
};
