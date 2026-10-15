import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GoScopeError } from "./scope";
import { buildGoLeaderboard, parseLeaderboardPeriod } from "./leaderboard";

const NOW = new Date("2026-10-15T09:30:00Z");
const staff = {
  is_hq: false,
  schedule_state: "scheduled" as const,
  today_location: { id: "loc-a", name: "新天地店" },
  hq_locations: [],
};

test("无归属：员工本店返回 200 空榜 + 明确不可用原因", () => {
  const d = buildGoLeaderboard({ actor: staff, period: "today", requestedLocationId: null, now: NOW });
  assert.deepEqual(d, {
    period: "today", date: "2026-10-15", as_of: NOW.toISOString(), complete: false, scope: "shop",
    shop: { id: "loc-a", name: "新天地店" }, rows: [], sales_assessment: false,
    reason: "employee_attribution_unavailable", message: "订单尚未记录销售归属，暂不能生成员工龙虎榜",
  });
});

test("month 期间日期为本月 1 日起", () => {
  const d = buildGoLeaderboard({ actor: staff, period: "month", requestedLocationId: null, now: NOW });
  assert.equal(d.period, "month");
  assert.equal(d.date, "2026-10");
});

test("员工请求他店 → 403，不返回任何数据", () => {
  assert.throws(
    () => buildGoLeaderboard({ actor: staff, period: "today", requestedLocationId: "loc-b", now: NOW }),
    (e: unknown) => e instanceof GoScopeError && e.status === 403 && e.code === "location_forbidden",
  );
});

test("员工今天休息/无排班 → 403", () => {
  for (const s of ["off", "no_schedule"] as const) {
    assert.throws(
      () => buildGoLeaderboard({ actor: { ...staff, schedule_state: s, today_location: null }, period: "today", requestedLocationId: null, now: NOW }),
      (e: unknown) => e instanceof GoScopeError && e.status === 403,
    );
  }
});

test("总部不指定门店 → 422（不提供跨店门店榜）；指定未授权门店 → 404", () => {
  const hq = { is_hq: true, schedule_state: "no_schedule" as const, today_location: null, hq_locations: [{ id: "loc-a", name: "A店" }] };
  assert.throws(() => buildGoLeaderboard({ actor: hq, period: "today", requestedLocationId: null, now: NOW }),
    (e: unknown) => e instanceof GoScopeError && e.status === 422 && e.code === "location_required");
  assert.throws(() => buildGoLeaderboard({ actor: hq, period: "today", requestedLocationId: "loc-x", now: NOW }),
    (e: unknown) => e instanceof GoScopeError && e.status === 404);
  const ok = buildGoLeaderboard({ actor: hq, period: "today", requestedLocationId: "loc-a", now: NOW });
  assert.deepEqual(ok.shop, { id: "loc-a", name: "A店" });
  assert.deepEqual(ok.rows, []);
});

test("period 只接受 today|month", () => {
  assert.equal(parseLeaderboardPeriod(null), "today");
  assert.equal(parseLeaderboardPeriod("month"), "month");
  assert.equal(parseLeaderboardPeriod("year"), null);
});

test("路由先鉴权再算范围，且不读销售数据", () => {
  const src = readFileSync(new URL("../../routes/api/public/go/leaderboard.ts", import.meta.url), "utf8");
  assert.ok(src.indexOf("authenticateGoActor") < src.indexOf("buildGoLeaderboard("));
  assert.doesNotMatch(src, /youzan_orders|store_offline_sales_entries|commerce_orders|supabaseAdmin/);
  assert.match(src, /private, no-store/);
});
