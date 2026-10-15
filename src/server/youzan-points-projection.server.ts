// 有赞积分只读投影：有赞是积分唯一权威来源，ERP / 小程序只做展示与审计。
// - 余额：youzan.crm.customer.points.get/1.0.0（现有适配器）→ youzan_points_projection（版本单调）。
// - 记录：仅官方 changelog.search 日志 → youzan_points_log_entries（去重、只追加）。
// - 失败：只打失败标记，保留上次有赞数据；从未成功则 balance=null，绝不回退本地自主积分，也不默认为 0。
// - 身份：只用调用方 customerId → 腾讯可信映射（唯一 HQ + 唯一 yz_open_id）；冲突/缺失不查有赞。
// 本模块不读写本地钱包与自主积分账本，不调用任何有赞写接口。
import { createHash } from "node:crypto";
import type { LogMember, LogPageResult, RawLogItem } from "./youzan-points-log-query.server";

export type ProjectionRow = {
  customer_id: string; kdt_id: number | null; yz_open_id: string | null;
  balance: number | null; points_account_version: string | null;
  balance_synced_at: string | null; balance_failed_at: string | null; balance_failure: string | null;
  log_synced_at: string | null; log_window_start?: string | null; log_failed_at: string | null; log_failure: string | null;
};
export type LogEntryInput = { entry_key: string; amount: number; balance_after: number | null; description: string | null;
  occurred_at: number; expires_at: number | null; biz_value: string | null };
export type LogView = { id: string; amount: number; balance_after: number | null; description: string | null; occurred_at: string; expires_at: string | null };
export type BalanceResult = "applied" | "same_version" | "stale" | "version_conflict" | "identity_conflict" | "customer_inactive";

export interface ProjectionStore {
  read(customerId: string): Promise<ProjectionRow | null>;
  recordBalance(a: { customerId: string; kdtId: number; yzOpenId: string; point: number; version: string; startedAt: number }): Promise<BalanceResult>;
  recordFailure(a: { customerId: string; kind: "balance" | "log"; reason: string; attemptedAt: number }): Promise<void>;
  recordLogs(a: { customerId: string; kdtId: number; yzOpenId: string; entries: LogEntryInput[]; windowStart: number; startedAt: number }): Promise<{ result: string; inserted: number }>;
  listLogs(customerId: string, limit: number, before?: { occurredAt: string; id: string }): Promise<LogView[]>;
}

export type MemberResolution = { kind: "found"; customerId: string; kdtId: number; yzOpenId: string } | { kind: "missing" } | { kind: "conflict" } | { kind: "unavailable" };
export type BalanceQueryResult = { kind: "ok"; point: number; version: string } | { kind: "blocked"; reason: string } | { kind: "unavailable" };

export type ProjectionDeps = {
  resolveMember(customerId: string): Promise<MemberResolution>;
  queryBalance(m: LogMember): Promise<BalanceQueryResult>;
  logsEnabled(): boolean;
  queryLogs?(m: LogMember, q: { page: number; beginAt: number; endAt: number }): Promise<LogPageResult>;
  now?: () => number;
};

export const LOG_WINDOW_DAYS = 30;
export const PROJECTION_FRESH_MS = 30_000;
const LOG_MAX_PAGES = 6;
const REASON = /^[a-z0-9_]{1,60}$/;
const reason = (r: string) => (REASON.test(r) ? r : "youzan_read_failed");

export function logEntryKey(i: Pick<RawLogItem, "amount" | "current" | "description" | "created_at" | "biz_value">) {
  return createHash("sha256").update(JSON.stringify([i.created_at, i.amount, i.current ?? null, i.biz_value ?? null, i.description ?? null])).digest("hex");
}
const maskDescription = (d: string | null | undefined) => (d ? d.replace(/\d{7,}/g, m => `${m.slice(0, 2)}****${m.slice(-2)}`).slice(0, 200) : null);

export type AccountPointsView = {
  source: "youzan"; balance: number | null;
  status: "ok" | "failed" | "pending" | "mapping_missing";
  synced_at: string | null; reason: string | null;
};
export type LedgerView = {
  source: "youzan"; status: "ok" | "failed" | "pending" | "mapping_missing" | "permission_unverified";
  synced_at: string | null; reason: string | null; window_days: number; window_start: string | null;
  items: LogView[]; next_cursor: string | null;
};

export type SyncStatus = "synced" | "stale" | "unavailable" | "pending";
/** 前端契约：points:{source,balance,sync_status,last_synced_at,reason}。失败不回退：有旧值→stale，无值→unavailable。 */
export function toPointsContract(v: AccountPointsView) {
  const sync_status: SyncStatus = v.status === "ok" ? "synced" : v.status === "pending" ? "pending"
    : v.balance !== null ? "stale" : "unavailable";
  return { source: "youzan" as const, balance: v.balance, sync_status, last_synced_at: v.synced_at, reason: v.reason };
}
/** 账本 data 保持旧数组字段（id,delta,source_type,source_id,balance_after,created_at），只多 description/expires_at。 */
export function toLegacyLedgerRows(items: LogView[]) {
  return items.map(i => ({ id: i.id, delta: i.amount, source_type: "youzan", source_id: null, balance_after: i.balance_after,
    created_at: i.occurred_at, description: i.description, expires_at: i.expires_at }));
}
export function toLedgerSync(l: LedgerView, balance: AccountPointsView | null) {
  const log_status: SyncStatus = l.status === "ok" ? "synced" : l.status === "pending" ? "pending"
    : l.status === "failed" && l.synced_at ? "stale" : "unavailable";
  return {
    source: "youzan" as const,
    balance: balance ? toPointsContract(balance) : null,
    log: { sync_status: log_status, last_synced_at: l.synced_at, reason: l.reason,
      range: { kind: "recent_window", days: l.window_days, begin_at: l.window_start, end_at: l.synced_at, full_history: false } },
    next_cursor: l.next_cursor,
  };
}

function balanceView(row: ProjectionRow | null, mapped: boolean): AccountPointsView {
  if (!mapped) return { source: "youzan", balance: null, status: "mapping_missing", synced_at: null, reason: "youzan_member_not_linked" };
  const synced = row?.balance_synced_at ? Date.parse(row.balance_synced_at) : null;
  const failed = row?.balance_failed_at ? Date.parse(row.balance_failed_at) : null;
  const balance = synced !== null && row?.balance != null ? Number(row.balance) : null;
  const isFailed = failed !== null && (synced === null || failed > synced);
  return { source: "youzan", balance, status: isFailed ? "failed" : balance === null ? "pending" : "ok",
    synced_at: row?.balance_synced_at ?? null, reason: isFailed ? row?.balance_failure ?? null : null };
}

export function createPointsProjection(store: ProjectionStore, deps: ProjectionDeps) {
  const now = deps.now ?? Date.now;
  // 同一投影实例（一次请求）内共享可信身份解析，避免重复查 shops / 映射库。
  const members = new Map<string, Promise<MemberResolution>>();
  function member(customerId: string): Promise<MemberResolution> {
    let p = members.get(customerId);
    if (!p) {
      p = deps.resolveMember(customerId).catch(() => ({ kind: "unavailable" }) as const);
      members.set(customerId, p);
    }
    return p;
  }
  // 只复用 30 秒内、同一可信身份、最近一次为成功（无更新失败）的有赞投影；其余一律真实刷新。
  const sameIdentity = (row: ProjectionRow | null, m: Extract<MemberResolution, { kind: "found" }>) =>
    !!row && row.yz_open_id === m.yzOpenId && Number(row.kdt_id) === m.kdtId;
  const freshAt = (synced: string | null | undefined, failed: string | null | undefined) => {
    if (!synced) return false;
    const s = Date.parse(synced);
    if (failed && Date.parse(failed) >= s) return false;
    const age = now() - s;
    return age >= 0 && age < PROJECTION_FRESH_MS;
  };

  async function syncBalance(m: Extract<MemberResolution, { kind: "found" }>) {
    const startedAt = now();
    let r: BalanceQueryResult;
    try { r = await deps.queryBalance(m); } catch { r = { kind: "unavailable" }; }
    if (r.kind !== "ok") {
      await store.recordFailure({ customerId: m.customerId, kind: "balance", reason: r.kind === "blocked" ? reason(r.reason) : "youzan_read_unavailable", attemptedAt: startedAt });
      return;
    }
    const res = await store.recordBalance({ customerId: m.customerId, kdtId: m.kdtId, yzOpenId: m.yzOpenId, point: r.point, version: r.version, startedAt });
    if (res === "identity_conflict" || res === "version_conflict" || res === "customer_inactive") {
      await store.recordFailure({ customerId: m.customerId, kind: "balance", reason: res, attemptedAt: startedAt });
    }
  }

  async function syncLogs(m: Extract<MemberResolution, { kind: "found" }>) {
    const startedAt = now();
    const beginAt = startedAt - LOG_WINDOW_DAYS * 86400_000 + 60_000;
    const fail = (why: string) => store.recordFailure({ customerId: m.customerId, kind: "log", reason: reason(why), attemptedAt: startedAt });
    if (!deps.queryLogs) return fail("log_adapter_missing");
    const seen = new Set<string>();
    const entries: LogEntryInput[] = [];
    for (let page = 1; page <= LOG_MAX_PAGES; page++) {
      let r: LogPageResult;
      try { r = await deps.queryLogs(m, { page, beginAt, endAt: startedAt }); } catch { r = { kind: "unavailable" }; }
      if (r.kind !== "ok") return fail(r.kind === "blocked" ? r.reason : "youzan_read_unavailable");
      for (const i of r.items) {
        const key = logEntryKey(i);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ entry_key: key, amount: i.amount, balance_after: i.current ?? null, description: maskDescription(i.description),
          occurred_at: i.created_at, expires_at: i.expired_at ?? null, biz_value: i.biz_value?.slice(0, 128) ?? null });
      }
      if (r.items.length < 50 || page * 50 >= r.totalCount) break;
      if (page === LOG_MAX_PAGES) return fail("log_page_limit_reached");
    }
    const res = await store.recordLogs({ customerId: m.customerId, kdtId: m.kdtId, yzOpenId: m.yzOpenId, entries, windowStart: beginAt, startedAt });
    if (res.result !== "recorded") await fail(res.result);
  }

  return {
    async accountPoints(customerId: string, opts: { sync: boolean }): Promise<AccountPointsView> {
      const m = await member(customerId);
      if (m.kind === "missing" || m.kind === "conflict") return balanceView(null, false);
      let row = await store.read(customerId);
      if (m.kind === "found" && opts.sync) {
        const fresh = sameIdentity(row, m) && row!.balance != null && freshAt(row!.balance_synced_at, row!.balance_failed_at);
        if (!fresh) { await syncBalance(m); row = await store.read(customerId); }
      }
      const view = balanceView(row, true);
      if (m.kind === "unavailable") return { ...view, status: view.balance === null ? "pending" : "failed", reason: "member_link_unavailable" };
      return view;
    },
    async ledger(customerId: string, opts: { sync: boolean; limit?: number; cursor?: string | null }): Promise<LedgerView> {
      const base = { source: "youzan" as const, window_days: LOG_WINDOW_DAYS, window_start: null as string | null };
      const m = await member(customerId);
      if (m.kind === "missing" || m.kind === "conflict") return { ...base, status: "mapping_missing", synced_at: null, reason: "youzan_member_not_linked", items: [], next_cursor: null };
      const enabled = deps.logsEnabled();
      if (m.kind === "found" && opts.sync && enabled) {
        const prev = await store.read(customerId);
        if (!(sameIdentity(prev, m) && freshAt(prev!.log_synced_at, prev!.log_failed_at))) await syncLogs(m);
      }
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 50);
      let before: { occurredAt: string; id: string } | undefined;
      if (opts.cursor) {
        const [occurredAt, id] = opts.cursor.split("|");
        if (occurredAt && !Number.isNaN(Date.parse(occurredAt)) && /^[0-9a-f-]{1,64}$/i.test(id ?? "")) before = { occurredAt, id };
      }
      const [row, items] = await Promise.all([store.read(customerId), store.listLogs(customerId, limit, before)]);
      const last = items.length === limit ? items[items.length - 1] : null;
      const next_cursor = last ? `${last.occurred_at}|${last.id}` : null;
      if (!enabled) return { ...base, status: "permission_unverified", synced_at: null, reason: "youzan_points_log_not_enabled", items, next_cursor };
      const synced = row?.log_synced_at ? Date.parse(row.log_synced_at) : null;
      const failed = row?.log_failed_at ? Date.parse(row.log_failed_at) : null;
      const isFailed = m.kind === "unavailable" || (failed !== null && (synced === null || failed > synced));
      return { ...base, window_start: row?.log_window_start ?? null, status: isFailed ? "failed" : synced === null ? "pending" : "ok", synced_at: row?.log_synced_at ?? null,
        reason: m.kind === "unavailable" ? "member_link_unavailable" : isFailed ? row?.log_failure ?? null : null, items, next_cursor };
    },
    /** 补偿刷新：只刷新已映射的顾客（由受信定时任务调用）。 */
    async refresh(customerId: string) {
      const m = await member(customerId);
      if (m.kind !== "found") return m.kind;
      await syncBalance(m);
      if (deps.logsEnabled()) await syncLogs(m);
      return "refreshed";
    },
  };
}
