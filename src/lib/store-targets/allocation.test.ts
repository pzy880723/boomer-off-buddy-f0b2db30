import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  allocateMonthlyTarget,
  isoWeekday,
  monthDates,
  splitByWeightFen,
} from "./allocation";

describe("splitByWeightFen", () => {
  test("整数分精确拆分，合计恒等于总额", () => {
    const parts = splitByWeightFen(100_001, [1, 1, 1]);
    assert.equal(parts.reduce((a, b) => a + b, 0), 100_001);
    assert.deepEqual(parts, [33_334, 33_334, 33_333]);
  });

  test("权重全 0 时返回全 0", () => {
    assert.deepEqual(splitByWeightFen(500, [0, 0]), [0, 0]);
  });

  test("拒绝非整数分", () => {
    assert.throws(() => splitByWeightFen(1.5, [1]), /整数分/);
  });
});

describe("monthDates / isoWeekday", () => {
  test("2026-02 为 28 天", () => {
    assert.equal(monthDates("2026-02").length, 28);
  });
  test("周一=1，周日=7", () => {
    assert.equal(isoWeekday("2026-09-07"), 1);
    assert.equal(isoWeekday("2026-09-13"), 7);
  });
});

describe("allocateMonthlyTarget", () => {
  const base = {
    month: "2026-09",
    monthlyTargetFen: 30_000_00,
    today: "2026-09-01",
  };

  test("按自然日拆分且日目标合计精确等于月目标", () => {
    const r = allocateMonthlyTarget(base);
    assert.equal(r.days.length, 30);
    assert.equal(r.total_fen, 30_000_00);
    assert.ok(r.days.every((d) => Number.isInteger(d.target_amount_fen)));
    assert.deepEqual(r.warnings, []);
  });

  test("周末权重更高：周六目标 > 周三目标", () => {
    const r = allocateMonthlyTarget(base);
    const sat = r.days.find((d) => d.date === "2026-09-05")!;
    const wed = r.days.find((d) => d.date === "2026-09-02")!;
    assert.ok(sat.target_amount_fen > wed.target_amount_fen);
  });

  test("单日权重覆盖生效，且合计仍精确", () => {
    const r = allocateMonthlyTarget({
      ...base,
      dateWeightOverrides: { "2026-09-15": 5 },
    });
    const boosted = r.days.find((d) => d.date === "2026-09-15")!;
    const normal = r.days.find((d) => d.date === "2026-09-16")!;
    assert.ok(boosted.target_amount_fen > normal.target_amount_fen * 3);
    assert.equal(r.total_fen, 30_000_00);
  });

  test("闭店日目标为 0，其余日承接全部额度", () => {
    const r = allocateMonthlyTarget({ ...base, closedDates: ["2026-09-10"] });
    const closed = r.days.find((d) => d.date === "2026-09-10")!;
    assert.equal(closed.target_amount_fen, 0);
    assert.equal(closed.source, "closed_day");
    assert.equal(r.total_fen, 30_000_00);
  });

  test("过期日期不被重算：保留原值且标记 frozen", () => {
    const r = allocateMonthlyTarget({
      ...base,
      today: "2026-09-10",
      existingDays: [
        { date: "2026-09-01", target_amount_fen: 12_345, source: "allocated", is_locked: false },
      ],
    });
    const past = r.days.find((d) => d.date === "2026-09-01")!;
    assert.equal(past.target_amount_fen, 12_345);
    assert.equal(past.frozen, true);
    // 未生成目标的其它过期日保持 0，不追溯补目标
    assert.equal(r.days.find((d) => d.date === "2026-09-05")!.target_amount_fen, 0);
    assert.equal(r.total_fen, 30_000_00);
  });

  test("手工调整日被锁定，不受重算影响，其余日吸收差额", () => {
    const r = allocateMonthlyTarget({
      ...base,
      existingDays: [
        {
          date: "2026-09-20",
          target_amount_fen: 5_000_00,
          source: "manual_override",
          is_locked: true,
        },
      ],
    });
    const fixed = r.days.find((d) => d.date === "2026-09-20")!;
    assert.equal(fixed.target_amount_fen, 5_000_00);
    assert.equal(fixed.frozen, true);
    assert.equal(r.frozen_fen, 5_000_00);
    assert.equal(r.distributable_fen, 25_000_00);
    assert.equal(r.total_fen, 30_000_00);
  });

  test("冻结额超过月目标时不回收既有目标，并给出 warning", () => {
    const r = allocateMonthlyTarget({
      ...base,
      monthlyTargetFen: 1_000_00,
      existingDays: [
        {
          date: "2026-09-20",
          target_amount_fen: 5_000_00,
          source: "manual_override",
          is_locked: true,
        },
      ],
    });
    assert.equal(r.distributable_fen, 0);
    assert.equal(r.total_fen, 5_000_00);
    assert.ok(r.warnings.some((w) => w.includes("超过月目标")));
  });

  test("拒绝非整数分与负数月目标", () => {
    assert.throws(() => allocateMonthlyTarget({ ...base, monthlyTargetFen: 10.5 }), /整数分/);
    assert.throws(() => allocateMonthlyTarget({ ...base, monthlyTargetFen: -1 }), /负数/);
  });
});
