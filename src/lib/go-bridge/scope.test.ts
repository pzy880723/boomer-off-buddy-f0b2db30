import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  GoScopeError,
  gapFen,
  maskName,
  maskPhone,
  mergeCompleteness,
  resolveGoScope,
  sumNullable,
} from "./scope";

const HQ_LOCATIONS = ["loc-a", "loc-b", "loc-c"];

describe("resolveGoScope", () => {
  test("HQ 无门店也能全局浏览所有真实门店", () => {
    const s = resolveGoScope({
      isHq: true,
      scheduleState: "no_schedule",
      hqLocationIds: HQ_LOCATIONS,
    });
    assert.equal(s.mode, "hq_all");
    assert.deepEqual(s.locationIds, HQ_LOCATIONS);
    assert.equal(s.todayLocationId, null);
  });

  test("HQ 指定单店", () => {
    const s = resolveGoScope({
      isHq: true,
      requestedLocationId: "loc-b",
      scheduleState: "no_schedule",
      hqLocationIds: HQ_LOCATIONS,
    });
    assert.equal(s.mode, "single");
    assert.deepEqual(s.locationIds, ["loc-b"]);
  });

  test("HQ 指定不存在门店返回 404", () => {
    assert.throws(
      () =>
        resolveGoScope({
          isHq: true,
          requestedLocationId: "loc-x",
          scheduleState: "no_schedule",
          hqLocationIds: HQ_LOCATIONS,
        }),
      (e: GoScopeError) => e.code === "location_not_found" && e.status === 404,
    );
  });

  test("员工没有门店不会被当成 HQ", () => {
    assert.throws(
      () => resolveGoScope({ isHq: false, scheduleState: "no_schedule", hqLocationIds: HQ_LOCATIONS }),
      (e: GoScopeError) => e.code === "no_schedule_today" && e.status === 403,
    );
  });

  test("休息 / 无排班 / 不可用 三态分开", () => {
    const state = (s: "off" | "no_schedule" | "unavailable") => {
      try {
        resolveGoScope({ isHq: false, scheduleState: s, hqLocationIds: HQ_LOCATIONS });
        return "no-throw";
      } catch (e) {
        return `${(e as GoScopeError).code}:${(e as GoScopeError).status}`;
      }
    };
    assert.equal(state("off"), "off_duty_today:403");
    assert.equal(state("no_schedule"), "no_schedule_today:403");
    assert.equal(state("unavailable"), "schedule_unavailable:503");
  });

  test("排班门店未映射到 ERP 门店时不放行", () => {
    assert.throws(
      () =>
        resolveGoScope({
          isHq: false,
          scheduleState: "scheduled",
          scheduledLocationId: null,
          hqLocationIds: HQ_LOCATIONS,
        }),
      (e: GoScopeError) => e.code === "schedule_unavailable",
    );
  });

  test("员工只能看当天排班店，跨店 403", () => {
    const ok = resolveGoScope({
      isHq: false,
      scheduleState: "scheduled",
      scheduledLocationId: "loc-a",
      hqLocationIds: HQ_LOCATIONS,
    });
    assert.deepEqual(ok.locationIds, ["loc-a"]);
    assert.equal(ok.todayLocationId, "loc-a");

    assert.throws(
      () =>
        resolveGoScope({
          isHq: false,
          requestedLocationId: "loc-b",
          scheduleState: "scheduled",
          scheduledLocationId: "loc-a",
          hqLocationIds: HQ_LOCATIONS,
        }),
      (e: GoScopeError) => e.code === "location_forbidden" && e.status === 403,
    );
  });
});

describe("金额与完整性", () => {
  test("任一门店缺数据合计为 null", () => {
    assert.equal(sumNullable([100, 200]), 300);
    assert.equal(sumNullable([100, null]), null);
  });

  test("gap 需要目标与实绩都存在", () => {
    assert.equal(gapFen(10000, 8000), 2000);
    assert.equal(gapFen(null, 8000), null);
    assert.equal(gapFen(10000, null), null);
  });

  test("任一门店 paid_gross 则整体 paid_gross 且 incomplete", () => {
    const m = mergeCompleteness([
      { complete: true, kind: "net", reasons: [] },
      { complete: false, kind: "paid_gross", reasons: ["refund_source_missing"] },
    ]);
    assert.equal(m.complete, false);
    assert.equal(m.kind, "paid_gross");
    assert.deepEqual(m.reasons, ["refund_source_missing"]);
  });

  test("范围内没有门店时明确标记", () => {
    const m = mergeCompleteness([]);
    assert.equal(m.complete, false);
    assert.ok(m.reasons.includes("no_locations_in_scope"));
  });
});

describe("脱敏", () => {
  test("姓名与手机号", () => {
    assert.equal(maskName("张三"), "张*");
    assert.equal(maskName("张三丰"), "张*丰");
    assert.equal(maskName(null), null);
    assert.equal(maskPhone("13800008000"), "138****8000");
    assert.equal(maskPhone("123"), null);
  });
});
