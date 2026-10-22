import { test } from "node:test";
import assert from "node:assert/strict";
import { runBatchMarks, type BatchSkuRow } from "./product-marks-batch.server.ts";

const T0 = "2026-10-22T10:00:00.000Z";
function fixture() {
  const db = new Map<string, BatchSkuRow>([
    ["a", { id: "a", status: "active", is_custom_price: true, kind: "single", stock_qty: 1, price_tier: 39, featured_stamp: null, notice_tags: ["not_edible"], fankuang_override: null, updated_at: T0 }],
    ["b", { id: "b", status: "active", is_custom_price: true, kind: "single", stock_qty: 1, price_tier: 39, featured_stamp: "new", notice_tags: [], fankuang_override: null, updated_at: T0 }],
    ["other", { id: "other", status: "active", is_custom_price: true, kind: "single", stock_qty: 1, price_tier: 39, featured_stamp: null, notice_tags: [], fankuang_override: null, updated_at: T0 }],
  ]);
  let n = 0; const writes: Array<[string, Record<string, unknown>]> = [];
  const deps = {
    loadSkus: async (ids: string[]) => ids.flatMap((id) => (db.get(id) ? [{ ...db.get(id)! }] : [])),
    skusAtLocations: async (ids: string[], locs: string[]) => new Set(locs.includes("L1") ? ids.filter((i) => i !== "other") : []),
    casUpdate: async (id: string, expected: string, patch: Record<string, unknown>) => {
      const row = db.get(id)!;
      if (row.updated_at !== expected) return null;
      writes.push([id, patch]);
      const next = `2026-10-22T10:00:0${++n}.000Z`;
      db.set(id, { ...row, ...patch, updated_at: next });
      return next;
    },
  };
  return { db, deps, writes };
}
const items = (...ids: string[]) => ids.map((id) => ({ id, expected_updated_at: T0 }));
const manager = { hq: false, managerLocationIds: ["L1"] };

test("manager: per-item store scope, only target field written, results per item", async () => {
  const { db, deps, writes } = fixture();
  const r = await runBatchMarks(deps, manager, { op: { kind: "notice", add: ["parts_missing"], remove: [] }, location_id: "L1", items: items("a", "b", "other", "missing") });
  assert.deepEqual(r.map((x) => [x.id, x.result, x.reason ?? null]),
    [["a", "success", null], ["b", "success", null], ["other", "skipped", "no_permission"], ["missing", "failed", "not_found"]]);
  assert.deepEqual(writes, [["a", { notice_tags: ["not_edible", "parts_missing"] }], ["b", { notice_tags: ["parts_missing"] }]]);
  assert.equal(db.get("b")!.featured_stamp, "new");
});

test("non-manager or foreign store: nothing written", async () => {
  const { deps, writes } = fixture();
  const r = await runBatchMarks(deps, manager, { op: { kind: "stamp", value: "rare" }, location_id: "L2", items: items("a") });
  assert.deepEqual(r, [{ id: "a", result: "skipped", reason: "no_permission" }]);
  const r2 = await runBatchMarks(deps, { hq: false, managerLocationIds: [] }, { op: { kind: "stamp", value: "rare" }, location_id: "L1", items: items("a") });
  assert.equal(r2[0].result, "skipped"); assert.equal(writes.length, 0);
  const r3 = await runBatchMarks(deps, manager, { op: { kind: "stamp", value: "rare" }, location_id: null, items: items("other") });
  assert.deepEqual([r3[0].result, r3[0].reason], ["skipped", "no_permission"]); assert.equal(writes.length, 0);
});

test("CAS: someone else's edit is not overwritten; retry with fresh version succeeds; replay is idempotent", async () => {
  const { db, deps, writes } = fixture();
  db.set("a", { ...db.get("a")!, featured_stamp: "limited", updated_at: "2026-10-22T11:00:00.000Z" });
  const r = await runBatchMarks(deps, { hq: true, managerLocationIds: [] }, { op: { kind: "stamp", value: "rare" }, location_id: null, items: items("a") });
  assert.deepEqual([r[0].result, r[0].reason], ["failed", "version_conflict"]);
  assert.equal(db.get("a")!.featured_stamp, "limited"); assert.equal(writes.length, 0);
  const retry = await runBatchMarks(deps, { hq: true, managerLocationIds: [] }, { op: { kind: "stamp", value: "rare" }, location_id: null,
    items: [{ id: "a", expected_updated_at: r[0].updated_at! }] });
  assert.equal(retry[0].result, "success");
  const replay = await runBatchMarks(deps, { hq: true, managerLocationIds: [] }, { op: { kind: "stamp", value: "rare" }, location_id: null, items: items("a") });
  assert.equal(replay[0].result, "unchanged"); assert.equal(writes.length, 1);
});

test("invalid op rejected; flawed add skipped not faked", async () => {
  const { deps } = fixture();
  await assert.rejects(runBatchMarks(deps, { hq: true, managerLocationIds: [] },
    { op: { kind: "notice", add: ["function_uncertain", "function_unavailable"], remove: [] }, location_id: null, items: items("a") }));
  const r = await runBatchMarks(deps, { hq: true, managerLocationIds: [] }, { op: { kind: "notice", add: ["flawed"], remove: [] }, location_id: null, items: items("a") });
  assert.deepEqual([r[0].result, r[0].reason], ["skipped", "flawed_requires_annotation"]);
});
