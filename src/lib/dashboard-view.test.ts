import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  dashboardRange,
  validateDashboardRange,
  displayAmount,
  displayCount,
} from "./dashboard-view";

test("today is based on Shanghai, not the browser or UTC day", () => {
  assert.deepEqual(dashboardRange("today", new Date("2026-09-07T17:00:00Z")), {
    start: "2026-09-08",
    end: "2026-09-08",
  });
});
test("yesterday crosses year boundaries", () => {
  assert.deepEqual(dashboardRange("yesterday", new Date("2026-01-01T01:00:00Z")), {
    start: "2025-12-31",
    end: "2025-12-31",
  });
});
test("month preset ends today, not the 31st", () => {
  assert.deepEqual(dashboardRange("month", new Date("2026-02-28T03:00:00Z")), {
    start: "2026-02-01",
    end: "2026-02-28",
  });
});
test("reject nonexistent dates, reversed ranges and >93 days", () => {
  assert.ok(validateDashboardRange({ start: "2026-02-30", end: "2026-03-01" }));
  assert.ok(validateDashboardRange({ start: "2026-09-08", end: "2026-09-07" }));
  assert.ok(validateDashboardRange({ start: "2026-01-01", end: "2026-12-31" }));
  assert.ok(validateDashboardRange({ start: "", end: "2026-09-07" }));
});
test("accept leap dates and exactly 93 inclusive days", () => {
  assert.equal(validateDashboardRange({ start: "2024-02-29", end: "2024-02-29" }), null);
  assert.equal(validateDashboardRange({ start: "2026-01-01", end: "2026-04-03" }), null);
  assert.ok(validateDashboardRange({ start: "2026-01-01", end: "2026-04-04" }));
});
test("keep cents, negative refunds, zero and unavailable distinct", () => {
  assert.equal(displayAmount(1290), "¥12.90");
  assert.equal(displayAmount(-1290), "-¥12.90");
  assert.equal(displayAmount(0), "¥0.00");
  assert.equal(displayAmount(null), "待核对");
  assert.equal(displayAmount(Number.NaN), "待核对");
  assert.equal(displayCount(null), "待核对");
  assert.equal(displayCount(0), "0");
});
