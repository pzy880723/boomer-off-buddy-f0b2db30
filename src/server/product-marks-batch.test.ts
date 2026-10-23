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
  const r = await runBatchMarks(deps, { hq: true, managerLocationIds: [] }, { op: { kind: "stamp", value: "rare" }, location_id: "L1", items: items("a") });
  assert.deepEqual([r[0].result, r[0].reason], ["failed", "version_conflict"]);
  assert.equal(db.get("a")!.featured_stamp, "limited"); assert.equal(writes.length, 0);
  const retry = await runBatchMarks(deps, { hq: true, managerLocationIds: [] }, { op: { kind: "stamp", value: "rare" }, location_id: "L1",
    items: [{ id: "a", expected_updated_at: r[0].updated_at! }] });
  assert.equal(retry[0].result, "success");
  const replay = await runBatchMarks(deps, { hq: true, managerLocationIds: [] }, { op: { kind: "stamp", value: "rare" }, location_id: "L1", items: items("a") });
  assert.equal(replay[0].result, "unchanged"); assert.equal(writes.length, 1);
});

test("invalid op rejected; flawed add skipped not faked", async () => {
  const { deps } = fixture();
  await assert.rejects(runBatchMarks(deps, { hq: true, managerLocationIds: [] },
    { op: { kind: "notice", add: ["function_uncertain", "function_unavailable"], remove: [] }, location_id: null, items: items("a") }));
  const r = await runBatchMarks(deps, { hq: true, managerLocationIds: [] }, { op: { kind: "notice", add: ["flawed"], remove: [] }, location_id: "L1", items: items("a") });
  assert.deepEqual([r[0].result, r[0].reason], ["skipped", "flawed_requires_annotation"]);
});

test("HQ also requires one explicit location and cannot edit foreign-location SKUs", async () => {
  const { deps, writes } = fixture();
  const actor = { hq: true, managerLocationIds: [] };
  const noScope = await runBatchMarks(deps, actor, { op: { kind: "stamp", value: "rare" }, location_id: null, items: items("a") });
  assert.equal(noScope[0].reason, "no_permission");
  const scoped = await runBatchMarks(deps, actor, { op: { kind: "stamp", value: "rare" }, location_id: "L1", items: items("other") });
  assert.equal(scoped[0].reason, "no_permission");
  assert.equal(writes.length, 0);
});

test("CAS rejects a one-microsecond difference without a write", async () => {
  const { db, deps, writes } = fixture();
  db.set("a", { ...db.get("a"), id: "a", updated_at: "2026-10-22T10:00:00.000001Z" });
  const r = await runBatchMarks(deps, manager, { op: { kind: "stamp", value: "rare" }, location_id: "L1", items: items("a") });
  assert.equal(r[0].reason, "version_conflict");
  assert.equal(writes.length, 0);
});

test("retry keeps original confirmed version and never overwrites another edit", async () => {
  const { db, deps, writes } = fixture();
  db.set("a", { ...db.get("a"), id: "a", featured_stamp: "limited", updated_at: "2026-10-22T11:00:00Z" });
  const input = { op: { kind: "stamp" as const, value: "rare" as const }, location_id: "L1", items: items("a") };
  const first = await runBatchMarks(deps, manager, input);
  const retry = await runBatchMarks(deps, manager, input);
  assert.equal(first[0].reason, "version_conflict");
  assert.equal(retry[0].reason, "version_conflict");
  assert.equal(db.get("a")?.featured_stamp, "limited");
  assert.equal(writes.length, 0);
});

test("401/403 abort remaining items, never continue after permission failure", async () => {
  for (const status of [401, 403]) {
    const { deps, writes } = fixture();
    let calls = 0;
    deps.casUpdate = async () => { calls++; throw new Response("Forbidden", { status }); };
    await assert.rejects(runBatchMarks(deps, manager, { op: { kind: "stamp", value: "rare" }, location_id: "L1", items: items("a", "b") }),
      (error: unknown) => error instanceof Response && error.status === status);
    assert.equal(calls, 1);
    assert.equal(writes.length, 0);
  }
});

test("same-millisecond 123456/123999 preview conflict cannot reach CAS", async () => {
  const { db, deps, writes } = fixture();
  const row = db.get("a");
  assert.ok(row);
  db.set("a", { ...row, featured_stamp: "limited", updated_at: "2026-10-23T04:07:00.123999Z" });
  const result = await runBatchMarks(deps, manager, { op: { kind: "stamp", value: "rare" }, location_id: "L1",
    items: [{ id: "a", expected_updated_at: "2026-10-23T04:07:00.123456Z" }] });
  assert.equal(result[0].reason, "version_conflict");
  assert.equal(writes.length, 0);
  assert.equal(db.get("a")?.featured_stamp, "limited");
});

test("CAS receives the client-confirmed version, not the equivalent fresh row representation", async () => {
  const { db, deps } = fixture();
  const row = db.get("a");
  assert.ok(row);
  db.set("a", { ...row, updated_at: "2026-10-23T04:07:00.123456+00:00" });
  const expected = "2026-10-23T04:07:00.123456Z";
  const versions: string[] = [];
  deps.casUpdate = async (_id, version) => { versions.push(version); return null; };
  const result = await runBatchMarks(deps, manager, { op: { kind: "stamp", value: "rare" }, location_id: "L1",
    items: [{ id: "a", expected_updated_at: expected }] });
  assert.deepEqual(versions, [expected]);
  assert.equal(result[0].reason, "version_conflict");
});

test("HQ uses skusAtLocations for the explicit current store, never all selected ids", async () => {
  const { deps, writes } = fixture();
  const scopes: string[][] = [];
  deps.skusAtLocations = async (_ids, locations) => { scopes.push(locations); return new Set(["a"]); };
  const result = await runBatchMarks(deps, { hq: true, managerLocationIds: ["L1", "L2"] },
    { op: { kind: "stamp", value: "rare" }, location_id: "L1", items: items("a", "b", "other") });
  assert.deepEqual(scopes, [["L1"]]);
  assert.deepEqual(result.map((r) => [r.id, r.result]), [["a", "success"], ["b", "skipped"], ["other", "skipped"]]);
  assert.deepEqual(writes, [["a", { featured_stamp: "rare" }]]);
});
