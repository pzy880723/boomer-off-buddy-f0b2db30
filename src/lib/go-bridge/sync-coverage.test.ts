import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { completedSyncCoverage } from "./sync-coverage";

const start = "2026-09-07T16:00:00.000Z";
const end = "2026-09-08T16:00:00.000Z";
const now = "2026-09-07T18:00:00.000Z";
const row = (from: string, through: string) => ({
  window_start: from,
  window_end: end,
  last_completed_scan_end: through,
  last_completed_at: now,
});
const coverage = (rows: Parameters<typeof completedSyncCoverage>[0]["rows"], at = now) =>
  completedSyncCoverage({ rows, startUtc: start, endUtc: end, now: new Date(at) });

describe("completed update-window coverage", () => {
  it("uses completed scan proof in an open pending window, not future midnight", () => {
    const result = coverage([row(start, "2026-09-07T17:50:00.000Z")]);
    assert.deepEqual(result, {
      syncedThrough: "2026-09-07T17:50:00.000Z",
      hasSnapshot: true,
      fresh: true,
      wholeDayCovered: false,
    });
  });
  it("no completed proof does not establish a true zero", () => {
    assert.equal(coverage([]).hasSnapshot, false);
    assert.equal(coverage([{ ...row(start, now), last_completed_scan_end: null }]).fresh, false);
  });
  it("does not bridge a gap with later completed windows", () => {
    const result = coverage([
      row(start, "2026-09-07T16:30:00.000Z"),
      row("2026-09-07T17:00:00.000Z", now),
    ]);
    assert.equal(result.syncedThrough, "2026-09-07T16:30:00.000Z");
    assert.equal(result.fresh, false);
  });
  it("joins adjacent completed intervals and caps to the requested day", () => {
    const result = coverage([
      row("2026-09-07T17:00:00.000Z", now),
      row("2026-09-07T00:00:00.000Z", "2026-09-07T17:00:00.000Z"),
    ]);
    assert.equal(result.syncedThrough, now);
    assert.equal(result.fresh, true);
  });
  it("keeps stale snapshot time but does not call it fresh", () => {
    const result = coverage([row(start, "2026-09-07T17:00:00.000Z")]);
    assert.equal(result.hasSnapshot, true);
    assert.equal(result.fresh, false);
  });
  it("historical day requires complete coverage to its end", () => {
    const nextDay = "2026-09-09T00:00:00.000Z";
    assert.equal(coverage([row(start, "2026-09-08T15:59:00.000Z")], nextDay).fresh, false);
    const result = coverage([{ ...row(start, end), last_completed_at: nextDay }], nextDay);
    assert.equal(result.wholeDayCovered, true);
    assert.equal(result.fresh, true);
  });
  it("rejects future, invalid and unfinished evidence", () => {
    for (const bad of [
      { ...row(start, now), last_completed_at: null },
      row(start, end),
      row(start, "not-a-date"),
      { ...row(start, now), window_end: start },
      { ...row(start, now), last_completed_at: "2026-09-07T17:00:00.000Z" },
    ])
      assert.equal(coverage([bad]).hasSnapshot, false);
  });
});
