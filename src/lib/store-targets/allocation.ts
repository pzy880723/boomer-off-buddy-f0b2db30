/**
 * 门店「月目标 → 日目标」拆分算法（纯函数，可单测，无 IO）。
 *
 * 硬性口径：
 *  - 金额一律使用整数「分」(fen)，绝不出现浮点累计误差。
 *  - 拆分结果对「本次参与拆分的自然日」求和，必须精确等于剩余可分配额度。
 *  - 已过期日期（< 今天，Asia/Shanghai）与手工锁定日永不被重算覆盖。
 *  - 实绩未达标不会摊到剩余日：这里只按目标与权重分配，不读任何销售数据。
 */

export type WeekdayWeights = Record<string, number>; // "1"=周一 ... "7"=周日

export type ExistingDay = {
  date: string; // yyyy-mm-dd
  target_amount_fen: number;
  source: "allocated" | "manual_override" | "closed_day";
  is_locked: boolean;
};

export type AllocationInput = {
  /** 目标月份，格式 yyyy-mm */
  month: string;
  /** 当月目标金额（分） */
  monthlyTargetFen: number;
  /** 周一~周日权重，缺省视为 1 */
  weekdayWeights?: WeekdayWeights;
  /** 指定日期权重覆盖：{ "2026-09-15": 2.5 } */
  dateWeightOverrides?: Record<string, number>;
  /** 闭店日：权重视为 0，目标 0 */
  closedDates?: string[];
  /** 库中已有的当月日目标 */
  existingDays?: ExistingDay[];
  /** 今天（Asia/Shanghai 的自然日 yyyy-mm-dd）。用于判断哪些日期已过期不可重算。 */
  today: string;
};

export type AllocatedDay = {
  date: string;
  weekday: number; // 1..7
  weight: number;
  target_amount_fen: number;
  source: "allocated" | "manual_override" | "closed_day";
  frozen: boolean; // true = 本次未重算（过期日或锁定日）
};

export type AllocationResult = {
  month: string;
  days: AllocatedDay[];
  monthly_target_fen: number;
  frozen_fen: number;
  distributable_fen: number;
  allocated_fen: number;
  /** frozen + allocated，必须等于 monthly_target_fen，否则 warnings 会说明原因 */
  total_fen: number;
  warnings: string[];
};

const DEFAULT_WEEKDAY_WEIGHTS: WeekdayWeights = {
  "1": 1,
  "2": 1,
  "3": 1,
  "4": 1,
  "5": 1,
  "6": 1.5,
  "7": 1.5,
};

export function parseMonth(month: string): { year: number; monthIndex: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`月份格式必须是 yyyy-mm，收到：${month}`);
  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) throw new Error(`非法月份：${month}`);
  return { year, monthIndex };
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** ISO 星期：周一=1 ... 周日=7 */
export function isoWeekday(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=周日
  return wd === 0 ? 7 : wd;
}

export function monthDates(month: string): string[] {
  const { year, monthIndex } = parseMonth(month);
  const n = daysInMonth(year, monthIndex);
  const out: string[] = [];
  for (let d = 1; d <= n; d += 1) {
    out.push(`${month}-${String(d).padStart(2, "0")}`);
  }
  return out;
}

function assertInt(name: string, v: number) {
  if (!Number.isFinite(v) || !Number.isInteger(v)) {
    throw new Error(`${name} 必须是整数分，收到：${v}`);
  }
}

/**
 * 最大余数法：把 total（分）按 weights 精确拆成整数分，合计恒等于 total。
 * 权重全 0 时返回全 0（余额由调用方以 warning 说明）。
 */
export function splitByWeightFen(totalFen: number, weights: number[]): number[] {
  assertInt("totalFen", totalFen);
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((s, w) => s + (w > 0 ? w : 0), 0);
  if (sum <= 0) return new Array(n).fill(0);

  const base: number[] = new Array(n).fill(0);
  const remainders: { i: number; frac: number }[] = [];
  let used = 0;
  for (let i = 0; i < n; i += 1) {
    const w = weights[i] > 0 ? weights[i] : 0;
    const exact = (totalFen * w) / sum;
    const floored = Math.floor(exact);
    base[i] = floored;
    used += floored;
    remainders.push({ i, frac: exact - floored });
  }
  let leftover = totalFen - used;
  // 余数大者优先；完全相同则日期靠前优先（i 升序，稳定）
  remainders.sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
  let k = 0;
  while (leftover > 0 && remainders.length > 0) {
    const target = remainders[k % remainders.length];
    if (weights[target.i] > 0) {
      base[target.i] += 1;
      leftover -= 1;
    }
    k += 1;
    if (k > n * 2 + leftover) break;
  }
  return base;
}

export function allocateMonthlyTarget(input: AllocationInput): AllocationResult {
  const {
    month,
    monthlyTargetFen,
    weekdayWeights,
    dateWeightOverrides = {},
    closedDates = [],
    existingDays = [],
    today,
  } = input;

  assertInt("monthlyTargetFen", monthlyTargetFen);
  if (monthlyTargetFen < 0) throw new Error("月目标不能为负数");

  const warnings: string[] = [];
  const weekMap = { ...DEFAULT_WEEKDAY_WEIGHTS, ...(weekdayWeights ?? {}) };
  const closed = new Set(closedDates);
  const existing = new Map(existingDays.map((d) => [d.date, d]));
  const dates = monthDates(month);

  // 1. 冻结日：已过期（严格早于今天）或手工锁定 / 手工覆盖
  const frozen: AllocatedDay[] = [];
  const openForAlloc: { date: string; weight: number }[] = [];
  let frozenFen = 0;

  for (const date of dates) {
    const prev = existing.get(date);
    const expired = date < today;
    const locked = !!prev && (prev.is_locked || prev.source === "manual_override");

    if (prev && (expired || locked)) {
      frozen.push({
        date,
        weekday: isoWeekday(date),
        weight: 0,
        target_amount_fen: prev.target_amount_fen,
        source: prev.source,
        frozen: true,
      });
      frozenFen += prev.target_amount_fen;
      continue;
    }
    if (!prev && expired) {
      // 过期但从未生成过目标：保持 0，且不参与本次分配（不追溯补目标）
      frozen.push({
        date,
        weekday: isoWeekday(date),
        weight: 0,
        target_amount_fen: 0,
        source: "allocated",
        frozen: true,
      });
      continue;
    }
    if (closed.has(date)) {
      frozen.push({
        date,
        weekday: isoWeekday(date),
        weight: 0,
        target_amount_fen: 0,
        source: "closed_day",
        frozen: false,
      });
      continue;
    }
    const wd = isoWeekday(date);
    const override = dateWeightOverrides[date];
    const weight = Number(override ?? weekMap[String(wd)] ?? 1);
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`日期 ${date} 的权重非法：${String(override ?? weekMap[String(wd)])}`);
    }
    openForAlloc.push({ date, weight });
  }

  // 2. 剩余可分配额度
  let distributable = monthlyTargetFen - frozenFen;
  if (distributable < 0) {
    warnings.push(
      `已冻结日目标合计 ${frozenFen} 分已超过月目标 ${monthlyTargetFen} 分，剩余日按 0 处理，不回收既有目标。`,
    );
    distributable = 0;
  }
  if (openForAlloc.length === 0 && distributable > 0) {
    warnings.push(`本月没有可分配的日期，剩余 ${distributable} 分未分配。`);
  }
  const weightSum = openForAlloc.reduce((s, d) => s + d.weight, 0);
  if (openForAlloc.length > 0 && weightSum <= 0 && distributable > 0) {
    warnings.push(`可分配日期权重合计为 0，剩余 ${distributable} 分未分配。`);
  }

  const amounts = splitByWeightFen(distributable, openForAlloc.map((d) => d.weight));
  const allocated: AllocatedDay[] = openForAlloc.map((d, i) => ({
    date: d.date,
    weekday: isoWeekday(d.date),
    weight: d.weight,
    target_amount_fen: amounts[i],
    source: "allocated",
    frozen: false,
  }));

  const days = [...frozen, ...allocated].sort((a, b) => a.date.localeCompare(b.date));
  const allocatedFen = allocated.reduce((s, d) => s + d.target_amount_fen, 0);
  const totalFen = days.reduce((s, d) => s + d.target_amount_fen, 0);

  if (totalFen !== monthlyTargetFen) {
    warnings.push(
      `日目标合计 ${totalFen} 分 ≠ 月目标 ${monthlyTargetFen} 分（差额 ${monthlyTargetFen - totalFen} 分），原因见上方说明。`,
    );
  }

  return {
    month,
    days,
    monthly_target_fen: monthlyTargetFen,
    frozen_fen: frozenFen,
    distributable_fen: distributable,
    allocated_fen: allocatedFen,
    total_fen: totalFen,
    warnings,
  };
}
