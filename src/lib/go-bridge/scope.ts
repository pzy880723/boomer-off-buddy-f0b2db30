/**
 * BOOMER GO 首页范围解析（纯逻辑，可单测，不访问数据库 / 不解析 token）。
 *
 * 铁律：
 *  - 总部（HQ）是 ERP 里显式配置的角色，HQ 名下没有门店也能全局浏览；
 *    绝不能因为「一个门店都没有」就反推成 HQ。
 *  - 员工的有效门店只来自「当天（Asia/Shanghai）唯一排班」+ 可信 GO 门店映射；
 *    没有排班 / 休息 / 读取失败三态分开，绝不回退到固定 profile 门店。
 *  - 越权访问一律 403，不静默降级成自己的门店。
 *  - 金额缺失一律 null，多店合计时任一店缺失 → 合计 null + incomplete。
 */

export type ScheduleState =
  /** 当天有唯一排班且门店映射可信 */
  | "scheduled"
  /** 当天排班为休息 */
  | "off"
  /** 当天没有排班记录 */
  | "no_schedule"
  /** GO 读取失败 / 排班冲突 / 门店未映射 —— 不可判定，禁止放行 */
  | "unavailable";

export type GoScopeMode = "hq_all" | "single";

export class GoScopeError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 403) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type GoScopeInput = {
  /** ERP 显式角色判定的结果，不由门店数量推断 */
  isHq: boolean;
  requestedLocationId?: string | null;
  scheduleState: ScheduleState;
  /** scheduleState=scheduled 时必须给出，已通过 go_shop_location_links 映射 */
  scheduledLocationId?: string | null;
  /** 全部真实门店（不含仓库），供 HQ 使用 */
  hqLocationIds: string[];
};

export type GoScope = {
  mode: GoScopeMode;
  locationIds: string[];
  /** 员工当天所在门店；HQ 全局浏览时为 null */
  todayLocationId: string | null;
};

export function resolveGoScope(input: GoScopeInput): GoScope {
  if (input.isHq) {
    if (input.requestedLocationId) {
      if (!input.hqLocationIds.includes(input.requestedLocationId)) {
        throw new GoScopeError("location_not_found", "该门店不存在或已停用", 404);
      }
      return {
        mode: "single",
        locationIds: [input.requestedLocationId],
        todayLocationId: null,
      };
    }
    return { mode: "hq_all", locationIds: input.hqLocationIds, todayLocationId: null };
  }

  switch (input.scheduleState) {
    case "off":
      throw new GoScopeError("off_duty_today", "今天休息，没有可查看的门店业绩");
    case "no_schedule":
      throw new GoScopeError("no_schedule_today", "今天没有排班，无法确定所属门店");
    case "unavailable":
      throw new GoScopeError("schedule_unavailable", "排班信息暂时不可用，请稍后再试", 503);
    case "scheduled":
      break;
    default:
      throw new GoScopeError("schedule_unavailable", "排班状态未知", 503);
  }

  const locationId = input.scheduledLocationId;
  if (!locationId) {
    throw new GoScopeError("schedule_unavailable", "排班门店未映射到 ERP 门店", 503);
  }
  if (input.requestedLocationId && input.requestedLocationId !== locationId) {
    throw new GoScopeError("location_forbidden", "只能查看今天排班所在门店的数据");
  }
  return { mode: "single", locationIds: [locationId], todayLocationId: locationId };
}

/** 任一为 null → null，绝不按 0 相加 */
export function sumNullable(values: Array<number | null>): number | null {
  if (values.some((v) => v == null)) return null;
  return values.reduce<number>((s, v) => s + (v as number), 0);
}

export function gapFen(target: number | null, actual: number | null): number | null {
  if (target == null || actual == null) return null;
  return target - actual;
}

export type StoreCompleteness = {
  complete: boolean;
  /** paid_gross = 已付款毛额（未扣退款），net = 已扣成功退款 */
  kind: "paid_gross" | "net";
  reasons: string[];
};

export function mergeCompleteness(stores: StoreCompleteness[]): {
  complete: boolean;
  kind: "paid_gross" | "net";
  reasons: string[];
} {
  const reasons = new Set<string>();
  let complete = stores.length > 0;
  let kind: "paid_gross" | "net" = "net";
  for (const s of stores) {
    if (!s.complete) complete = false;
    if (s.kind === "paid_gross") kind = "paid_gross";
    for (const r of s.reasons) reasons.add(r);
  }
  if (stores.length === 0) reasons.add("no_locations_in_scope");
  return { complete, kind, reasons: [...reasons] };
}

/** 姓名脱敏：张三 → 张*；张三丰 → 张*丰 */
export function maskName(name: string | null | undefined): string | null {
  if (!name) return null;
  const chars = [...name.trim()];
  if (chars.length === 0) return null;
  if (chars.length === 1) return chars[0];
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${"*".repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

/** 手机号脱敏：138****8000 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}
