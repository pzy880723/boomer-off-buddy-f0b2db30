import { test } from "node:test";
import assert from "node:assert/strict";
import { dashboardGate, loadMeasurementTasks, type MeasureRow } from "./handheld-dashboard-measurements";

test("dashboard without employee session is 401", async () => {
  assert.deepEqual(await dashboardGate(null, async () => true), { ok: false, status: 401, code: "session_required" });
});
test("dashboard for unauthorized location is 403", async () => {
  assert.deepEqual(await dashboardGate({ user_id: "u1" }, async () => false), { ok: false, status: 403, code: "location_forbidden" });
});
test("authorized session passes", async () => {
  assert.deepEqual(await dashboardGate({ user_id: "u1" }, async () => true), { ok: true });
});

test("measurement query failure is reported as unavailable, not empty", async () => {
  const r = await loadMeasurementTasks(async () => ({ data: null, error: { message: "boom" } }), "L1");
  assert.equal(r.status, "unavailable");
  assert.deepEqual(r.rows, []);
});

test("only this store's pending/claimed tasks are returned (mock DB behavior)", async () => {
  const db: (MeasureRow & { location_id: string })[] = [
    { id: "t1", sku_id: "s1", status: "pending", created_at: "2026-10-17T01:00:00Z", sku: { name: "A" }, location_id: "L1" },
    { id: "t2", sku_id: "s2", status: "claimed", created_at: "2026-10-17T02:00:00Z", sku: { name: "B" }, location_id: "L1" },
    { id: "t3", sku_id: "s3", status: "completed", created_at: "2026-10-17T00:00:00Z", sku: null, location_id: "L1" },
    { id: "t4", sku_id: "s4", status: "pending", created_at: "2026-10-17T00:00:00Z", sku: null, location_id: "L2" },
  ];
  const { measurementFilter } = await import("./handheld-dashboard-measurements");
  const query = async (loc: string) => ({ data: db.filter((r) => measurementFilter(r, loc)), error: null });
  const r = await loadMeasurementTasks(query, "L1");
  assert.equal(r.status, "ok");
  assert.deepEqual(r.rows.map((x) => x.id), ["t1", "t2"]);
});
