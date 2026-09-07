import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGoDailySummary, type GoStoreInput } from "./daily-contract";

const DATE = "2026-09-07";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function okStore(over: Partial<Extract<GoStoreInput, { status: "ok" }>> = {}): GoStoreInput {
  return {
    status: "ok",
    location_id: A,
    name: "中信泰富店",
    target_fen: 100000,
    youzan_fen: 80000,
    offline_fen: 20000,
    youzan_order_count: 4,
    offline_order_count: 1,
    youzan_bound: true,
    youzan_synced_through: `${DATE}T23:59:59.000Z`,
    day_covered_by_sync: true,
    has_refund_source: true,
    offline_entry_count: 1,
    ...over,
  };
}

describe("buildGoDailySummary", () => {
  it("never turns a failed source query into 0", () => {
    const out = buildGoDailySummary({
      date: DATE,
      scope: { mode: "single", locationIds: [A], todayLocationId: A },
      stores: [{ status: "error", location_id: A, name: "中信泰富店", code: "youzan_read_failed" }],
      generatedAt: "2026-09-07T10:00:00.000Z",
    });
    assert.equal(out.stores[0].actual_fen, null);
    assert.equal(out.stores[0].status, "error");
    assert.equal(out.totals.actual_fen, null);
    assert.equal(out.completeness.complete, false);
    assert.ok(out.completeness.reasons.includes("youzan_read_failed"));
  });

  it("does not report actual=0 when the day is not covered by a successful sync", () => {
    const out = buildGoDailySummary({
      date: DATE,
      scope: { mode: "single", locationIds: [A], todayLocationId: A },
      stores: [okStore({ youzan_fen: 0, offline_fen: 0, day_covered_by_sync: false })],
      generatedAt: "2026-09-07T10:00:00.000Z",
    });
    assert.equal(out.stores[0].actual_fen, null);
    assert.equal(out.stores[0].completeness.complete, false);
    assert.ok(out.stores[0].completeness.reasons.includes("sync_window_not_covered"));
  });

  it("marks incomplete whenever a refund source is missing (paid gross only)", () => {
    const out = buildGoDailySummary({
      date: DATE,
      scope: { mode: "single", locationIds: [A], todayLocationId: A },
      stores: [okStore({ has_refund_source: false })],
      generatedAt: "2026-09-07T10:00:00.000Z",
    });
    assert.equal(out.stores[0].actual_fen, 100000);
    assert.equal(out.completeness.kind, "paid_gross");
    assert.equal(out.completeness.complete, false);
    assert.ok(out.completeness.reasons.includes("refund_source_unavailable"));
  });

  it("returns the exact scope object contract", () => {
    const out = buildGoDailySummary({
      date: DATE,
      scope: { mode: "hq_all", locationIds: [A, B], todayLocationId: null },
      stores: [okStore(), okStore({ location_id: B, name: "朔门古港店" })],
      generatedAt: "2026-09-07T10:00:00.000Z",
    });
    assert.deepEqual(out.scope, {
      mode: "hq_all",
      location_ids: [A, B],
      today_location_id: null,
    });
    assert.equal(out.totals.actual_fen, 200000);
    assert.equal(out.totals.target_fen, 200000);
    assert.equal(out.totals.gap_fen, 0);
    assert.equal(out.totals.store_count, 2);
    assert.equal(out.completeness.complete, true);
  });

  it("nulls the total when any store amount is missing", () => {
    const out = buildGoDailySummary({
      date: DATE,
      scope: { mode: "hq_all", locationIds: [A, B], todayLocationId: null },
      stores: [okStore(), { status: "error", location_id: B, name: "朔门古港店", code: "x" }],
      generatedAt: "2026-09-07T10:00:00.000Z",
    });
    assert.equal(out.totals.actual_fen, null);
    assert.equal(out.totals.gap_fen, null);
  });
});
