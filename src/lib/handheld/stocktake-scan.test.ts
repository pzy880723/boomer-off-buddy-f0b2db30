import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyStocktakeScan, groupBackfill, normalizeScanEpcs } from "./stocktake-scan.ts";

test("fresh linked EPC is accepted", () => {
  assert.deepEqual(classifyStocktakeScan(["E1"], [{ epc: "E1", sku_id: "s1" }]), {
    received: 1, accepted: 1, unknown_count: 0, unknown: [],
  });
});

test("EPC known in inv_epcs but sku_id null is unknown, not accepted", () => {
  const r = classifyStocktakeScan(["E1"], [{ epc: "E1", sku_id: null }]);
  assert.equal(r.accepted, 0);
  assert.deepEqual(r.unknown, ["E1"]);
});

test("missing persisted row never counts as accepted", () => {
  const r = classifyStocktakeScan(["E1", "E2"], [{ epc: "E1", sku_id: "s1" }]);
  assert.equal(r.accepted, 1);
  assert.deepEqual(r.unknown, ["E2"]);
});

test("dedupe and trim", () => {
  assert.deepEqual(normalizeScanEpcs([" E1", "E1", ""]), ["E1"]);
});

test("backfill only groups EPCs with a real sku", () => {
  const g = groupBackfill(["E1", "E2", "E3"], new Map([["E1", "s1"], ["E2", null], ["E3", "s1"]]));
  assert.deepEqual([...g], [["s1", ["E1", "E3"]]]);
});
