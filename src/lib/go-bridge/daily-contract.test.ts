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
    has_current_day_snapshot: true,
    source_fresh: true,
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
      stores: [okStore({ youzan_fen: 0, offline_fen: 0, day_covered_by_sync: false,
        has_current_day_snapshot: false, source_fresh: false })],
      generatedAt: "2026-09-07T10:00:00.000Z",
    });
    assert.equal(out.stores[0].actual_fen, null);
    assert.equal(out.stores[0].completeness.complete, false);
    assert.ok(out.stores[0].completeness.reasons.includes("sync_window_not_covered"));
  });

  it("accepts a proved zero as of an open-day snapshot without claiming full-day coverage", () => {
    const out = buildGoDailySummary({
      date: DATE,
      scope: { mode: "single", locationIds: [A], todayLocationId: A },
      stores: [okStore({ youzan_fen: 0, offline_fen: 0, day_covered_by_sync: false,
        has_current_day_snapshot: true, source_fresh: true, has_refund_source: false })],
      generatedAt: "2026-09-07T10:00:00.000Z",
    });
    assert.equal(out.totals.actual_fen, 0);
    assert.equal(out.stores[0].completeness.source_fresh, true);
    assert.equal(out.stores[0].completeness.day_covered_by_sync, false);
    assert.equal(out.completeness.complete, false);
  });

  it("a stale proved snapshot keeps its value but cannot show achievement", () => {
    const out = buildGoDailySummary({
      date: DATE,
      scope: { mode: "single", locationIds: [A], todayLocationId: A },
      stores: [okStore({ source_fresh: false })],
      generatedAt: "2026-09-07T10:00:00.000Z",
    });
    assert.equal(out.totals.actual_fen, 100000);
    assert.equal(out.completeness.complete, false);
    assert.ok(out.completeness.reasons.includes("youzan_snapshot_stale"));
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

describe("freshness and refund semantics are explicit", () => {
  it("exposes per-store refunds_complete + freshness, and never uses generated_at as watermark", () => {
    const out = buildGoDailySummary({
      date: DATE,
      scope: { mode: "single", locationIds: [A], todayLocationId: A },
      stores: [okStore({ has_refund_source: false, youzan_synced_through: `${DATE}T09:00:00.000Z` })],
      generatedAt: "2026-09-07T10:00:00.000Z",
    });
    const s = out.stores[0];
    assert.equal(s.completeness.refunds_complete, false);
    assert.equal(s.completeness.kind, "paid_gross");
    assert.equal(s.completeness.complete, false);
    assert.equal(s.freshness.synced_through, `${DATE}T09:00:00.000Z`);
    assert.equal(out.freshness.synced_through, `${DATE}T09:00:00.000Z`);
    assert.notEqual(out.freshness.synced_through, out.generated_at);
    assert.equal(out.completeness.refunds_complete, false);
  });

  it("totals take the most conservative watermark across stores", () => {
    const out = buildGoDailySummary({
      date: DATE,
      scope: { mode: "hq_all", locationIds: [A, B], todayLocationId: null },
      stores: [
        okStore({ youzan_synced_through: `${DATE}T12:00:00.000Z` }),
        okStore({ location_id: B, name: "B 店", youzan_synced_through: `${DATE}T08:00:00.000Z` }),
      ],
      generatedAt: "2026-09-07T13:00:00.000Z",
    });
    assert.equal(out.freshness.synced_through, `${DATE}T08:00:00.000Z`);
  });

  it("an unknown store watermark makes the scope watermark unknown", () => {
    const out = buildGoDailySummary({
      date: DATE,
      scope: { mode: "hq_all", locationIds: [A, B], todayLocationId: null },
      stores: [
        okStore({ youzan_synced_through: `${DATE}T12:00:00.000Z` }),
        { status: "error", location_id: B, name: "B 店", code: "youzan_read_failed" },
      ],
      generatedAt: "2026-09-07T13:00:00.000Z",
    });
    assert.equal(out.freshness.synced_through, null);
    assert.equal(out.freshness.fresh, false);
    assert.equal(out.freshness.day_covered_by_sync, false);
  });
});
