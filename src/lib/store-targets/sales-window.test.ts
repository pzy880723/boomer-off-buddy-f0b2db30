import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  aggregateYouzanDay,
  computeDailyProgress,
  evaluateCompleteness,
  isYouzanPaidOrder,
  shanghaiDayWindow,
  shanghaiToday,
} from "./sales-window";

describe("shanghaiDayWindow", () => {
  test("Asia/Shanghai 自然日映射到 UTC [前一日16:00, 当日16:00)", () => {
    const w = shanghaiDayWindow("2026-09-07");
    assert.equal(w.startUtc, "2026-09-06T16:00:00.000Z");
    assert.equal(w.endUtc, "2026-09-07T16:00:00.000Z");
  });

  test("UTC 深夜属于次日上海日期", () => {
    assert.equal(shanghaiToday(new Date("2026-09-06T16:30:00.000Z")), "2026-09-07");
  });
});

describe("isYouzanPaidOrder", () => {
  test("已付款待发货计入业绩（不能只认 TRADE_SUCCESS）", () => {
    assert.equal(
      isYouzanPaidOrder({
        status: "WAIT_SELLER_SEND_GOODS",
        pay_time: "2026-09-07T02:00:00Z",
        payment: 100,
        total_fee: 100,
        post_fee: 0,
      }),
      true,
    );
  });

  test("未付款与已关闭不计入", () => {
    for (const status of ["WAIT_BUYER_PAY", "TRADE_CLOSED"]) {
      assert.equal(
        isYouzanPaidOrder({
          status,
          pay_time: "2026-09-07T02:00:00Z",
          payment: 100,
          total_fee: 100,
          post_fee: 0,
        }),
        false,
      );
    }
  });

  test("没有付款时间一律不计入", () => {
    assert.equal(
      isYouzanPaidOrder({
        status: "TRADE_SUCCESS",
        pay_time: null,
        payment: 100,
        total_fee: 100,
        post_fee: 0,
      }),
      false,
    );
  });
});

describe("aggregateYouzanDay", () => {
  test("业绩 = 已付款毛额 - 运费，并统计排除笔数", () => {
    const agg = aggregateYouzanDay([
      { status: "TRADE_SUCCESS", pay_time: "x", payment: 129.9, total_fee: 129.9, post_fee: 6 },
      { status: "WAIT_SELLER_SEND_GOODS", pay_time: "x", payment: 20, total_fee: 20, post_fee: 0 },
      { status: "TRADE_CLOSED", pay_time: "x", payment: 999, total_fee: 999, post_fee: 0 },
    ]);
    assert.equal(agg.gross_paid_fen, 12_990 + 2_000);
    assert.equal(agg.shipping_fee_fen, 600);
    assert.equal(agg.performance_fen, 12_990 + 2_000 - 600);
    assert.equal(agg.order_count, 2);
    assert.equal(agg.excluded_order_count, 1);
  });
});

describe("evaluateCompleteness", () => {
  const windowEndUtc = "2026-09-07T16:00:00.000Z";
  const now = new Date("2026-09-07T10:00:00.000Z");

  test("同步滞后 + 无退款源 → incomplete，且原因明确", () => {
    const c = evaluateCompleteness({
      youzanLastSyncedAt: "2026-08-29T00:00:00.000Z",
      windowEndUtc,
      hasRefundSource: false,
      now,
    });
    assert.equal(c.complete, false);
    assert.deepEqual(c.reasons, ["youzan_sync_stale", "refund_data_unavailable"]);
    assert.equal(c.refund_source, "unavailable");
    assert.equal(c.basis, "paid_gross_minus_shipping");
  });

  test("从未同步 → youzan_never_synced", () => {
    const c = evaluateCompleteness({
      youzanLastSyncedAt: null,
      windowEndUtc,
      hasRefundSource: true,
      now,
    });
    assert.equal(c.complete, false);
    assert.ok(c.reasons.includes("youzan_never_synced"));
  });

  test("同步及时且有退款源才可判定 complete", () => {
    const c = evaluateCompleteness({
      youzanLastSyncedAt: "2026-09-07T09:50:00.000Z",
      windowEndUtc,
      hasRefundSource: true,
      now,
    });
    assert.equal(c.complete, true);
    assert.deepEqual(c.reasons, []);
  });
});

describe("computeDailyProgress", () => {
  test("今日目标 / 实绩 / 差额", () => {
    const p = computeDailyProgress({
      targetFen: 100_000,
      youzanPerformanceFen: 60_000,
      offlineFen: 15_000,
    });
    assert.deepEqual(p, {
      target_fen: 100_000,
      achieved_fen: 75_000,
      gap_fen: 25_000,
      progress_pct: 75,
    });
  });

  test("没有目标时差额为 null，不臆造 0", () => {
    const p = computeDailyProgress({ targetFen: null, youzanPerformanceFen: 100, offlineFen: 0 });
    assert.equal(p.target_fen, null);
    assert.equal(p.gap_fen, null);
    assert.equal(p.progress_pct, null);
    assert.equal(p.achieved_fen, 100);
  });
});
