// 有赞官方积分日志只读适配器：youzan.crm.customer.points.changelog.search/4.0.2
// 官方文档 doc.youzanyun.com/detail/API/0/3410：begin/end 跨度 <31 天、每页最多 50 条，返回 data.items/data.paginator。
// 目录「支持业务」未列连锁 L，但 2026-10-15 腾讯固定出口对 HQ 两个可信映射实测 code=200，故默认启用；
// YOUZAN_POINTS_LOG_DISABLED=true 可紧急关闭（关闭时显示 unavailable，绝不伪造日志）。
// 只读；必须经 youzanFetch 固定出口；is_do_ext_point=false。
export const POINTS_LOG_API = "youzan.crm.customer.points.changelog.search";
export const POINTS_LOG_VERSION = "4.0.2";
export const POINTS_LOG_PAGE_SIZE = 50;

export type LogMember = { customerId: string; kdtId: number; yzOpenId: string };
export type RawLogItem = { amount: number; current?: number | null; description?: string | null; created_at: number; expired_at?: number | null; biz_value?: string | null };
export type LogPageResult =
  | { kind: "ok"; items: RawLogItem[]; totalCount: number }
  | { kind: "blocked"; reason: string }
  | { kind: "unavailable" };

type Deps = {
  proxyConfigured(): boolean;
  getAccessToken(kdtId: number): Promise<string | null>;
  fetchImpl(url: string, init: RequestInit): Promise<Response>;
};

function shanghai(ms: number) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const g = (t: string) => p.find(x => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}
const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : typeof v === "string" && /^-?\d{1,15}$/.test(v) ? Number(v) : null);

export function createYouzanPointsLogQuery(deps: Deps) {
  return async (m: LogMember, q: { page: number; beginAt: number; endAt: number }): Promise<LogPageResult> => {
    if (!deps.proxyConfigured()) return { kind: "blocked", reason: "youzan_proxy_not_configured" };
    const token = await deps.getAccessToken(m.kdtId);
    if (!token) return { kind: "blocked", reason: "shop_token_missing" };
    let res: Response;
    try {
      res = await deps.fetchImpl(`https://open.youzanyun.com/api/${POINTS_LOG_API}/${POINTS_LOG_VERSION}?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user: { account_id: m.yzOpenId, account_type: 5 },
          page: q.page, page_size: POINTS_LOG_PAGE_SIZE,
          begin_time: shanghai(q.beginAt), end_time: shanghai(q.endAt),
          is_do_ext_point: false,
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      return { kind: "unavailable" };
    }
    if (res.status >= 500 || res.status === 429) return { kind: "unavailable" };
    if (!res.ok) return { kind: "blocked", reason: "youzan_query_rejected" };
    let j: Record<string, unknown>;
    try { j = (await res.json()) as Record<string, unknown>; } catch { return { kind: "unavailable" }; }
    if (!j || j.success === false || !(j.code === 200 || j.code === 0)) {
      const code = int((j?.gw_err_resp as Record<string, unknown> | undefined)?.err_code ?? j?.code);
      return { kind: "blocked", reason: code ? `youzan_rejected_${code}`.slice(0, 60) : "youzan_query_rejected" };
    }
    // 4.0.2 在 data 下（4.0.1 为顶层），两者都按官方字段读取。
    const body = (j.data && typeof j.data === "object" ? j.data : j) as Record<string, unknown>;
    if (!Array.isArray(body.items)) return { kind: "blocked", reason: "log_response_incomplete" };
    const items: RawLogItem[] = [];
    for (const raw of body.items as Array<Record<string, unknown>>) {
      const amount = int(raw?.amount), created = int(raw?.created_at);
      if (amount === null || created === null || created <= 0) return { kind: "blocked", reason: "log_response_incomplete" };
      items.push({ amount, created_at: created, current: int(raw.current), expired_at: int(raw.expired_at),
        description: typeof raw.description === "string" ? raw.description : null,
        biz_value: typeof raw.biz_value === "string" ? raw.biz_value : null });
    }
    const total = int((body.paginator as Record<string, unknown> | undefined)?.total_count) ?? items.length;
    return { kind: "ok", items, totalCount: total };
  };
}
