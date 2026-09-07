import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CUSTOM_RANGE_DAYS,
  addDays,
  avgOrderValueFen,
  daysBetweenInclusive,
  evaluateSourceStale,
  refundWarnings,
  resolveLocationScope,
  resolveRange,
  sumMoney,
  trendWindow,
} from "./contract";

// 2026-09-07 16:00Z = 2026-09-08 00:00+08 → 上海已是 9 月 8 日
const NOW = new Date("2026-09-07T16:30:00Z");

describe("resolveRange", () => {
  test("today/yesterday 使用 Asia/Shanghai 自然日", () => {
    assert.deepEqual(resolveRange({ range: "today" }, NOW).start, "2026-09-08");
    const y = resolveRange({ range: "yesterday" }, NOW);
    assert.equal(y.start, "2026-09-07");
    assert.equal(y.end, "2026-09-07");
    assert.equal(y.days, 1);
  });

  test("month 从当月 1 日到今天", () => {
    const r = resolveRange({ range: "month" }, NOW);
    assert.equal(r.start, "2026-09-01");
    assert.equal(r.end, "2026-09-08");
    assert.equal(r.days, 8);
  });

  test("custom 超过 93 天被拒绝", () => {
    assert.throws(
      () => resolveRange({ range: "custom", start: "2026-01-01", end: "2026-12-31" }, NOW),
      /93/,
    );
    const ok = resolveRange({ range: "custom", start: "2026-06-01", end: "2026-08-01" }, NOW);
    assert.equal(ok.days, 62);
    assert.ok(ok.days <= MAX_CUSTOM_RANGE_DAYS);
  });

  test("非法日期与倒序区间被拒绝", () => {
    assert.throws(() =>
      resolveRange({ range: "custom", start: "2026-02-30", end: "2026-03-01" }, NOW),
    );
    assert.throws(() =>
      resolveRange({ range: "custom", start: "2026-03-05", end: "2026-03-01" }, NOW),
    );
    assert.throws(() => resolveRange({ range: "custom", start: "2026-03-01" }, NOW));
  });
});

describe("日期工具", () => {
  test("addDays 跨月跨年", () => {
    assert.equal(addDays("2026-02-28", 1), "2026-03-01");
    assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  });
  test("daysBetweenInclusive 含首尾", () => {
    assert.equal(daysBetweenInclusive("2026-09-01", "2026-09-01"), 1);
    assert.equal(daysBetweenInclusive("2026-09-01", "2026-09-07"), 7);
  });
  test("trendWindow 固定 7 天且止于 end", () => {
    const w = trendWindow("2026-09-08");
    assert.equal(w.dates.length, 7);
    assert.equal(w.start, "2026-09-02");
    assert.equal(w.dates.at(-1), "2026-09-08");
  });
});

describe("金额与警告", () => {
  test("任一渠道为 null 时合计为 null，不按 0 相加", () => {
    assert.equal(sumMoney([100, 200]), 300);
    assert.equal(sumMoney([100, null]), null);
  });

  test("客单价：无订单或无金额返回 null", () => {
    assert.equal(avgOrderValueFen(10000, 4), 2500);
    assert.equal(avgOrderValueFen(10000, 0), null);
    assert.equal(avgOrderValueFen(null, 4), null);
  });

  test("缺退款来源生成 channel 级 warning", () => {
    const w = refundWarnings([
      { key: "pos", refundSource: "available" },
      { key: "youzan", refundSource: "unavailable" },
    ]);
    assert.equal(w.length, 1);
    assert.equal(w[0].scope, "channel");
    assert.match(w[0].code, /youzan/);
  });

  test("同步水位落后判定 stale", () => {
    const end = "2026-09-08T00:00:00.000Z";
    assert.equal(evaluateSourceStale({ key: "youzan", lastSyncedAt: null }, end, NOW), true);
    assert.equal(
      evaluateSourceStale({ key: "youzan", lastSyncedAt: "2026-08-29T08:00:00.000Z" }, end, NOW),
      true,
    );
    assert.equal(
      evaluateSourceStale({ key: "pos", lastSyncedAt: "2026-09-07T16:20:00.000Z" }, end, NOW),
      false,
    );
  });
});

describe("门店范围授权", () => {
  const allowed = ["loc-a", "loc-b"];

  test("HQ 默认全部并纳入无门店线上订单", () => {
    const s = resolveLocationScope({ requested: "all", isHq: true, allowedLocationIds: allowed });
    assert.equal(s.mode, "all");
    assert.equal(s.includeUnassigned, true);
  });

  test("HQ 指定单店", () => {
    const s = resolveLocationScope({ requested: "loc-x", isHq: true, allowedLocationIds: [] });
    assert.deepEqual(s.locationIds, ["loc-x"]);
    assert.equal(s.includeUnassigned, false);
  });

  test("普通账号越权访问被拒绝", () => {
    assert.throws(
      () => resolveLocationScope({ requested: "loc-z", isHq: false, allowedLocationIds: allowed }),
      /无权/,
    );
  });

  test("普通账号未授权任何门店时报错，而不是返回全部", () => {
    assert.throws(
      () => resolveLocationScope({ requested: "all", isHq: false, allowedLocationIds: [] }),
      /没有被授权/,
    );
  });

  test("普通账号单店自动锁定该店", () => {
    const s = resolveLocationScope({
      requested: undefined,
      isHq: false,
      allowedLocationIds: ["loc-a"],
    });
    assert.equal(s.mode, "single");
    assert.equal(s.locationId, "loc-a");
    assert.equal(s.includeUnassigned, false);
  });
});
