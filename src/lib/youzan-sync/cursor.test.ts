import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFixedWindows, classifySliceOutcome, MAX_ATTEMPTS } from "./cursor";

describe("buildFixedWindows", () => {
  it("is idempotent: the same request twice yields byte-identical windows", () => {
    const a = buildFixedWindows({
      shopIds: ["s1"],
      now: new Date("2026-09-07T13:37:11.123Z"),
      days: 3,
      windowHours: 24,
    });
    const b = buildFixedWindows({
      shopIds: ["s1"],
      now: new Date("2026-09-07T21:04:59.987Z"),
      days: 3,
      windowHours: 24,
    });
    assert.deepEqual(a, b);
  });

  it("aligns windows to fixed UTC boundaries, never to Date.now()", () => {
    const w = buildFixedWindows({
      shopIds: ["s1"],
      now: new Date("2026-09-07T13:37:11.123Z"),
      days: 2,
      windowHours: 24,
    });
    assert.deepEqual(
      w.map((x: { shop_id: string; window_start: string; window_end: string }) => [
        x.window_start,
        x.window_end,
      ]),
      [
        ["2026-09-06T00:00:00.000Z", "2026-09-07T00:00:00.000Z"],
        ["2026-09-07T00:00:00.000Z", "2026-09-08T00:00:00.000Z"],
      ],
    );
  });

  it("covers every shop once per window", () => {
    const w = buildFixedWindows({
      shopIds: ["s1", "s2"],
      now: new Date("2026-09-07T13:00:00.000Z"),
      days: 2,
      windowHours: 24,
    });
    assert.equal(w.length, 4);
    assert.equal(
      new Set(
        w.map(
          (x: { shop_id: string; window_start: string; window_end: string }) =>
            `${x.shop_id}|${x.window_start}`,
        ),
      ).size,
      4,
    );
  });
});

describe("classifySliceOutcome", () => {
  const base = { startPage: 3, previousAttempts: 5 };

  it("treats a failed slice as an error and burns exactly one attempt", () => {
    const o = classifySliceOutcome(
      { ok: false, count: 0, message: "youzan 500", next_page: 3, method_label: null },
      base,
    );
    assert.equal(o.status, "error");
    assert.equal(o.attempts, 6);
    assert.equal(o.next_page, 3);
  });

  it("never marks a window done when every API version failed", () => {
    const o = classifySliceOutcome(
      { ok: false, count: 0, message: "all versions failed", next_page: null, method_label: null },
      base,
    );
    assert.equal(o.status, "error");
    assert.notEqual(o.next_page, null);
  });

  it("resets attempts after a page of real progress, so long windows never run out", () => {
    const o = classifySliceOutcome(
      { ok: true, count: 20, message: "ok", next_page: 6, method_label: "v4.0.4" },
      { startPage: 3, previousAttempts: MAX_ATTEMPTS - 1 },
    );
    assert.equal(o.status, "pending");
    assert.equal(o.attempts, 0);
    assert.equal(o.next_page, 6);
    assert.equal(o.method_label, "v4.0.4");
  });

  it("distinguishes an empty-but-successful window from a failure", () => {
    const o = classifySliceOutcome(
      { ok: true, count: 0, message: "empty", next_page: null, method_label: "v4.0.4" },
      base,
    );
    assert.equal(o.status, "done");
    assert.equal(o.empty, true);
  });

  it("does not stall when a successful slice reports no page advance", () => {
    const o = classifySliceOutcome(
      { ok: true, count: 0, message: "no advance", next_page: 3, method_label: "v4.0.4" },
      base,
    );
    assert.equal(o.status, "error");
    assert.equal(o.attempts, 6);
    assert.ok(o.reason);
  });

  it("gives up only after MAX_ATTEMPTS consecutive failures", () => {
    const o = classifySliceOutcome(
      { ok: false, count: 0, message: "boom", next_page: 3, method_label: null },
      { startPage: 3, previousAttempts: MAX_ATTEMPTS - 1 },
    );
    assert.equal(o.status, "failed");
    assert.equal(o.attempts, MAX_ATTEMPTS);
  });
});
