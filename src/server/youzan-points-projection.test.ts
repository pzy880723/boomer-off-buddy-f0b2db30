import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createPointsProjection,
  logEntryKey,
  type ProjectionRow,
  type ProjectionStore,
  type ProjectionDeps,
  type LogEntryInput,
} from "./youzan-points-projection.server";
import { createYouzanPointsLogQuery } from "./youzan-points-log-query.server";
import { toPointsContract, toLedgerSync, toLegacyLedgerRows } from "./youzan-points-projection.server";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

// In-memory store mirroring the SQL RPC contract (version-monotonic, failure timestamps).
function memStore() {
  const rows = new Map<string, ProjectionRow>();
  const logs: Array<LogEntryInput & { customer_id: string; id: string }> = [];
  const calls: string[] = [];
  const ensure = (c: string) => {
    if (!rows.has(c)) rows.set(c, { customer_id: c, kdt_id: null, yz_open_id: null, balance: null, points_account_version: null,
      balance_synced_at: null, balance_failed_at: null, balance_failure: null, log_synced_at: null, log_failed_at: null, log_failure: null });
    return rows.get(c)!;
  };
  const store: ProjectionStore = {
    async read(c) { calls.push(`read:${c}`); return rows.get(c) ?? null; },
    async recordBalance(a) {
      calls.push(`balance:${a.customerId}`);
      const r = ensure(a.customerId);
      if (r.yz_open_id && r.yz_open_id !== a.yzOpenId) return "identity_conflict";
      const cur = r.points_account_version === null ? null : BigInt(r.points_account_version);
      const v = BigInt(a.version);
      if (cur !== null && v < cur) return "stale";
      if (cur !== null && v === cur) {
        if (r.balance !== a.point) return "version_conflict";
        r.balance_synced_at = new Date(Math.max(Date.parse(r.balance_synced_at!), a.startedAt)).toISOString();
        return "same_version";
      }
      Object.assign(r, { kdt_id: a.kdtId, yz_open_id: a.yzOpenId, balance: a.point, points_account_version: a.version,
        balance_synced_at: new Date(Math.max(Date.parse(r.balance_synced_at ?? "1970-01-01"), a.startedAt)).toISOString() });
      return "applied";
    },
    async recordFailure(a) {
      calls.push(`fail:${a.kind}:${a.customerId}`);
      const r = ensure(a.customerId);
      const k = a.kind === "balance" ? "balance" : "log";
      const prev = r[`${k}_failed_at`];
      if (!prev || Date.parse(prev) < a.attemptedAt) {
        r[`${k}_failed_at`] = new Date(a.attemptedAt).toISOString();
        r[`${k}_failure`] = a.reason;
      }
    },
    async recordLogs(a) {
      calls.push(`logs:${a.customerId}`);
      const r = ensure(a.customerId);
      if (r.yz_open_id && r.yz_open_id !== a.yzOpenId) return { result: "identity_conflict", inserted: 0 };
      let inserted = 0;
      for (const e of a.entries) {
        if (logs.some(l => l.customer_id === a.customerId && l.entry_key === e.entry_key)) continue;
        logs.push({ ...e, customer_id: a.customerId, id: `log-${logs.length}` }); inserted++;
      }
      Object.assign(r, { kdt_id: a.kdtId, yz_open_id: a.yzOpenId }); // 与 SQL record_logs 一致
      r.log_synced_at = new Date(a.startedAt).toISOString();
      return { result: "recorded", inserted };
    },
    async listLogs(c, limit) {
      calls.push(`list:${c}`);
      return logs.filter(l => l.customer_id === c).sort((x, y) => y.occurred_at - x.occurred_at).slice(0, limit)
        .map(l => ({ id: l.id, amount: l.amount, balance_after: l.balance_after, description: l.description,
          occurred_at: new Date(l.occurred_at * 1000).toISOString(), expires_at: null }));
    },
  };
  return { store, rows, logs, calls };
}

let clock = Date.parse("2026-10-15T01:00:00Z");
const deps = (o: Partial<ProjectionDeps> = {}): ProjectionDeps => ({
  resolveMember: async (c) => (c === A ? { kind: "found", customerId: A, kdtId: 100, yzOpenId: "YZ-A" } : { kind: "missing" }),
  queryBalance: async () => ({ kind: "ok", point: 0, version: "5" }),
  logsEnabled: () => true,
  queryLogs: async () => ({ kind: "ok", items: [], totalCount: 0 }),
  now: () => (clock += 1000),
  ...o,
});

test("有赞 0 分必须显示 0（本地自主 3000 永不参与）", async () => {
  const { store } = memStore();
  const p = createPointsProjection(store, deps());
  const view = await p.accountPoints(A, { sync: true });
  assert.equal(view.source, "youzan");
  assert.equal(view.balance, 0);
  assert.equal(view.status, "ok");
  const src = readFileSync(new URL("./youzan-points-projection.server.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /pos_customer_wallets|commerce_points_ledger|commerce_points_record/);
});

test("同步失败保留上次有赞余额并标记失败，绝不回退本地或 0", async () => {
  const { store } = memStore();
  let fail = false;
  const p = createPointsProjection(store, deps({
    queryBalance: async () => (fail ? { kind: "unavailable" } : { kind: "ok", point: 250, version: "9" }),
  }));
  assert.equal((await p.accountPoints(A, { sync: true })).balance, 250);
  fail = true;
  clock += 31_000; // 超过 30 秒复用窗口才会真实刷新
  const v = await p.accountPoints(A, { sync: true });
  assert.equal(v.balance, 250);
  assert.equal(v.status, "failed");
  assert.equal(v.reason, "youzan_read_unavailable");
});

test("从未成功同步且失败 → balance null 状态 failed，不默认为 0", async () => {
  const { store } = memStore();
  const v = await createPointsProjection(store, deps({ queryBalance: async () => ({ kind: "blocked", reason: "shop_token_missing" }) }))
    .accountPoints(A, { sync: true });
  assert.equal(v.balance, null);
  assert.equal(v.status, "failed");
  assert.equal(v.reason, "shop_token_missing");
});

test("并发：慢的旧响应不能覆盖新数据", async () => {
  const { store, rows } = memStore();
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  let n = 0;
  const p = createPointsProjection(store, deps({
    queryBalance: async () => {
      n++;
      if (n === 1) { await gate; return { kind: "ok", point: 10, version: "3" }; }
      return { kind: "ok", point: 70, version: "4" };
    },
  }));
  const slow = p.accountPoints(A, { sync: true });
  const fast = await p.accountPoints(A, { sync: true });
  assert.equal(fast.balance, 70);
  release();
  await slow;
  assert.equal(rows.get(A)!.balance, 70);
});

test("未映射/冲突映射：不查有赞、不写投影、状态 mapping_missing", async () => {
  const { store, calls } = memStore();
  let queried = false;
  const p = createPointsProjection(store, deps({
    resolveMember: async () => ({ kind: "conflict" }),
    queryBalance: async () => { queried = true; return { kind: "ok", point: 1, version: "1" }; },
  }));
  const v = await p.accountPoints(B, { sync: true });
  assert.equal(queried, false);
  assert.equal(v.status, "mapping_missing");
  assert.equal(v.balance, null);
  assert.ok(!calls.some(c => c.startsWith("balance:")));
});

test("跨用户：只按调用方 customerId 读写，不能读到他人日志", async () => {
  const { store, calls } = memStore();
  const p = createPointsProjection(store, deps({
    queryLogs: async () => ({ kind: "ok", totalCount: 1, items: [{ amount: 5, current: 5, description: "A", created_at: 1760490000 }] }),
  }));
  await p.ledger(A, { sync: true });
  const other = await p.ledger(B, { sync: true });
  assert.deepEqual(other.items, []);
  assert.equal(other.status, "mapping_missing");
  assert.ok(calls.filter(c => c.startsWith("logs:")).every(c => c === `logs:${A}`));
});

test("余额与日志状态独立；日志未开通权限 → permission_unverified 且不伪造记录", async () => {
  const { store } = memStore();
  let logQueried = false;
  const p = createPointsProjection(store, deps({ logsEnabled: () => false, queryLogs: async () => { logQueried = true; return { kind: "ok", items: [], totalCount: 0 }; } }));
  const acc = await p.accountPoints(A, { sync: true });
  const led = await p.ledger(A, { sync: true });
  assert.equal(acc.status, "ok");
  assert.equal(led.status, "permission_unverified");
  assert.equal(led.source, "youzan");
  assert.deepEqual(led.items, []);
  assert.equal(logQueried, false);
});

test("日志分页、去重、只存官方字段；失败保留已有记录", async () => {
  const { store, logs } = memStore();
  const page = (n: number) => Array.from({ length: n }, (_, i) => ({ amount: i + 1, current: 100 + i, description: `d${i} 13812345678`, created_at: 1760490000 + i }));
  let fail = false;
  const p = createPointsProjection(store, deps({
    queryLogs: async (_m, q) => (fail ? { kind: "unavailable" } : q.page === 1 ? { kind: "ok", items: page(50), totalCount: 60 } : { kind: "ok", items: page(60).slice(50), totalCount: 60 }),
  }));
  const first = await p.ledger(A, { sync: true });
  assert.equal(first.status, "ok");
  assert.equal(logs.length, 60);
  assert.ok(logs.every(l => !/13812345678/.test(l.description ?? "")), "phone-like digits masked");
  await p.ledger(A, { sync: true });
  assert.equal(logs.length, 60, "replay dedupe");
  fail = true;
  clock += 31_000;
  const failed = await p.ledger(A, { sync: true });
  assert.equal(failed.status, "failed");
  assert.equal(failed.items.length, 50);
});

test("entry key 稳定且区分字段", () => {
  const e = { amount: 1, current: 2, description: "x", created_at: 3 };
  assert.equal(logEntryKey(e), logEntryKey({ ...e }));
  assert.notEqual(logEntryKey(e), logEntryKey({ ...e, amount: 2 }));
  assert.match(logEntryKey(e), /^[0-9a-f]{64}$/);
});

test("日志查询适配器：官方 changelog.search 4.0.2，只读、固定出口、data 嵌套、is_do_ext_point=false", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const q = createYouzanPointsLogQuery({
    proxyConfigured: () => true,
    getAccessToken: async () => "TOK",
    fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return Response.json({ code: 200, success: true, data: { paginator: { total_count: 1 }, items: [{ amount: -100, current: 0, description: "积分抵现", created_at: 1760490000 }] } }); },
  });
  const r = await q({ customerId: A, kdtId: 100, yzOpenId: "YZ-A" }, { page: 1, beginAt: Date.parse("2026-10-08T00:00:00Z"), endAt: Date.parse("2026-10-15T00:00:00Z") });
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") assert.equal(r.items[0].amount, -100);
  assert.match(calls[0].url, /youzan\.crm\.customer\.points\.changelog\.search\/4\.0\.2\?access_token=TOK$/);
  assert.deepEqual(calls[0].body.user, { account_id: "YZ-A", account_type: 5 });
  assert.equal(calls[0].body.is_do_ext_point, false);
  assert.equal(calls[0].body.page_size, 50);
  assert.equal(calls[0].body.begin_time, "2026-10-08 08:00:00");
  const blocked = await createYouzanPointsLogQuery({ proxyConfigured: () => false, getAccessToken: async () => "T", fetchImpl: async () => { throw Error("no"); } })(
    { customerId: A, kdtId: 100, yzOpenId: "Y" }, { page: 1, beginAt: 0, endAt: 1 });
  assert.deepEqual(blocked, { kind: "blocked", reason: "youzan_proxy_not_configured" });
});

test("对外路由只用登录顾客身份，不接收 phone/customer_id 参数", () => {
  for (const f of ["membership.account.ts", "membership.points-ledger.ts"]) {
    const src = readFileSync(new URL(`../routes/api/public/storefront/${f}`, import.meta.url), "utf8");
    assert.match(src, /auth\.customer\.id/);
    assert.doesNotMatch(src, /searchParams\.get\(["'](phone|customer_id|customerId)/);
  }
});

test("前端契约：points.sync_status 映射，失败不回退、缺映射不返回 0", () => {
  const base = { source: "youzan" as const, synced_at: "2026-10-15T05:00:00.000Z", reason: null };
  assert.deepEqual(toPointsContract({ ...base, balance: 0, status: "ok" }),
    { source: "youzan", balance: 0, sync_status: "synced", last_synced_at: base.synced_at, reason: null });
  assert.equal(toPointsContract({ ...base, balance: 250, status: "failed" }).sync_status, "stale");
  assert.equal(toPointsContract({ ...base, balance: null, status: "failed" }).sync_status, "unavailable");
  const missing = toPointsContract({ source: "youzan", balance: null, status: "mapping_missing", synced_at: null, reason: "youzan_member_not_linked" });
  assert.equal(missing.balance, null);
  assert.equal(missing.sync_status, "unavailable");
  assert.equal(toPointsContract({ ...base, balance: 5, status: "pending" }).sync_status, "pending");
});

test("账本 data 保持旧数组字段，points_sync 标明最近窗口而非全历史", () => {
  const rows = toLegacyLedgerRows([{ id: "x", amount: -100, balance_after: 0, description: "抵现", occurred_at: "2026-10-15T00:00:00.000Z", expires_at: null }]);
  assert.deepEqual(Object.keys(rows[0]).slice(0, 6), ["id", "delta", "source_type", "source_id", "balance_after", "created_at"]);
  assert.equal(rows[0].delta, -100);
  assert.equal(rows[0].source_type, "youzan");
  const sync = toLedgerSync({ source: "youzan", status: "ok", synced_at: "2026-10-15T05:00:00.000Z", reason: null, window_days: 30,
    window_start: "2026-09-15T05:01:00.000Z", items: [], next_cursor: null }, null);
  assert.equal(sync.log.sync_status, "synced");
  assert.equal(sync.log.range.full_history, false);
  assert.equal(sync.log.range.days, 30);
});

// ---- 30 秒可信投影复用 / 单请求共享身份解析 / 私有缓存头 ----
test("30 秒内已同步余额直接复用，不重复查有赞；超过 30 秒真实刷新", async () => {
  const { store } = memStore();
  let n = 0;
  const p = createPointsProjection(store, deps({ queryBalance: async () => { n++; return { kind: "ok", point: 12, version: String(n) }; } }));
  assert.equal((await p.accountPoints(A, { sync: true })).balance, 12);
  const again = await p.accountPoints(A, { sync: true });
  assert.equal(n, 1);
  assert.equal(again.status, "ok");
  clock += 31_000;
  await p.accountPoints(A, { sync: true });
  assert.equal(n, 2);
});

test("失败/从未同步/版本冲突不复用，按真实刷新执行", async () => {
  const { store } = memStore();
  let n = 0, mode: "ok" | "fail" | "conflict" = "fail";
  const p = createPointsProjection(store, deps({ queryBalance: async () => {
    n++;
    if (mode === "fail") return { kind: "unavailable" };
    return { kind: "ok", point: mode === "conflict" ? 99 : 5, version: "7" };
  } }));
  await p.accountPoints(A, { sync: true });
  await p.accountPoints(A, { sync: true });
  assert.equal(n, 2, "从未成功不得复用");
  mode = "ok"; await p.accountPoints(A, { sync: true });
  mode = "conflict"; const c = await p.accountPoints(A, { sync: true }); // 30 秒内仍 ok → 复用，不查
  assert.equal(n, 3); assert.equal(c.balance, 5);
  clock += 31_000; await p.accountPoints(A, { sync: true }); // 冲突 → 记录失败
  const after = await p.accountPoints(A, { sync: true });
  assert.equal(n, 5, "冲突后的失败状态不得复用");
  assert.equal(after.status, "failed");
});

test("30 秒内日志首次读取后复用，不反复全月拉取；cursor 合同不变", async () => {
  const { store } = memStore();
  let q = 0;
  const p = createPointsProjection(store, deps({ queryLogs: async () => { q++; return { kind: "ok", items: [], totalCount: 0 }; } }));
  const first = await p.ledger(A, { sync: true });
  assert.equal(q, 1); assert.equal(first.status, "ok");
  const second = await p.ledger(A, { sync: true });
  assert.equal(q, 1); assert.equal(second.status, "ok"); assert.equal(second.next_cursor, null);
  clock += 31_000; await p.ledger(A, { sync: true });
  assert.equal(q, 2);
});

test("同一投影实例内可信身份解析只做一次", async () => {
  const { store } = memStore();
  let r = 0;
  const p = createPointsProjection(store, deps({ resolveMember: async () => { r++; return { kind: "found", customerId: A, kdtId: 100, yzOpenId: "YZ-A" }; } }));
  await Promise.all([p.ledger(A, { sync: true }), p.accountPoints(A, { sync: true })]);
  await p.accountPoints(A, { sync: false });
  assert.equal(r, 1);
});

test("账户与积分记录接口声明 private, no-store", () => {
  for (const f of ["membership.account.ts", "membership.points-ledger.ts"]) {
    const src = readFileSync(new URL(`../routes/api/public/storefront/${f}`, import.meta.url), "utf8");
    assert.match(src, /private, no-store/);
  }
  const repo = readFileSync(new URL("../lib/membership/membership-repository.server.ts", import.meta.url), "utf8");
  assert.match(repo, /loadYouzanAccountPoints\(customerId, projection\)/, "积分记录须与余额共享同一投影实例");
});

// ---- 可信映射变更（YZ-A → YZ-B）后绝不展示旧身份数据 ----
async function seededA() {
  const s = memStore();
  const pA = createPointsProjection(s.store, deps({ queryBalance: async () => ({ kind: "ok", point: 880, version: "3" }),
    queryLogs: async () => ({ kind: "ok", items: [{ amount: 10, current: 880, description: "A", created_at: 1760000000, biz_value: "x" }], totalCount: 1 }) }));
  await pA.accountPoints(A, { sync: true });
  await pA.ledger(A, { sync: true });
  assert.equal(s.rows.get(A)!.yz_open_id, "YZ-A");
  return s;
}
const toB = (o: Partial<ProjectionDeps> = {}) => deps({ resolveMember: async () => ({ kind: "found", customerId: A, kdtId: 100, yzOpenId: "YZ-B" }), ...o });
const assertHiddenBalance = (v: { balance: number | null; status: string; reason: string | null }) => {
  assert.equal(v.balance, null); assert.equal(v.status, "mapping_missing"); assert.equal(v.reason, "identity_conflict");
  assert.equal(toPointsContract(v as never).sync_status, "unavailable");
};
const assertHiddenLedger = (l: { items: unknown[]; next_cursor: string | null; status: string; reason: string | null }) => {
  assert.deepEqual(l.items, []); assert.equal(l.next_cursor, null); assert.equal(l.status, "mapping_missing"); assert.equal(l.reason, "identity_conflict");
};

test("映射改为 YZ-B：余额 sync=true（有赞成功/拒绝/不可用）均不返回 A 旧余额", async () => {
  for (const q of [async () => ({ kind: "ok", point: 5, version: "9" }), async () => ({ kind: "blocked", reason: "x" }), async () => ({ kind: "unavailable" })] as ProjectionDeps["queryBalance"][]) {
    const { store, rows } = await seededA();
    assertHiddenBalance(await createPointsProjection(store, toB({ queryBalance: q })).accountPoints(A, { sync: true }));
    assert.equal(rows.get(A)!.balance, 880, "不删除历史");
  }
});

test("映射改为 YZ-B：sync=false 与 30 秒新鲜窗口不得绕过", async () => {
  const { store } = await seededA();
  const p = createPointsProjection(store, toB());
  assertHiddenBalance(await p.accountPoints(A, { sync: false }));
  assertHiddenLedger(await p.ledger(A, { sync: false }));
});

test("映射改为 YZ-B：日志首屏、cursor 翻页、日志拉取成功/失败都不返回 A 旧记录", async () => {
  for (const q of [async () => ({ kind: "ok", items: [], totalCount: 0 }), async () => ({ kind: "unavailable" })] as NonNullable<ProjectionDeps["queryLogs"]>[]) {
    const { store } = await seededA();
    const p = createPointsProjection(store, toB({ queryLogs: q }));
    assertHiddenLedger(await p.ledger(A, { sync: true }));
    assertHiddenLedger(await p.ledger(A, { sync: false, cursor: "2026-10-01T00:00:00.000Z|log-9" }));
  }
});

test("同步过程中被并发写回旧映射：以最终读取的行为准仍隐藏", async () => {
  const s = memStore();
  const p = createPointsProjection(s.store, toB({ queryBalance: async () => {
    Object.assign(s.rows.get(A) ?? (s.rows.set(A, { customer_id: A, kdt_id: null, yz_open_id: null, balance: null, points_account_version: null,
      balance_synced_at: null, balance_failed_at: null, balance_failure: null, log_synced_at: null, log_failed_at: null, log_failure: null }), s.rows.get(A)!),
      { kdt_id: 100, yz_open_id: "YZ-A", balance: 777, points_account_version: "99", balance_synced_at: new Date(clock).toISOString() });
    return { kind: "ok", point: 1, version: "1" };
  } }));
  assertHiddenBalance(await p.accountPoints(A, { sync: true }));
});

test("同一 yz_open_id 但 kdt 不同也视为身份冲突", async () => {
  const { store } = await seededA();
  const p = createPointsProjection(store, deps({ resolveMember: async () => ({ kind: "found", customerId: A, kdtId: 200, yzOpenId: "YZ-A" }) }));
  assertHiddenBalance(await p.accountPoints(A, { sync: false }));
  assertHiddenLedger(await p.ledger(A, { sync: false }));
});
