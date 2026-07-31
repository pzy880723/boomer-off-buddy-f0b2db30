import assert from "node:assert/strict";
import test from "node:test";

import { snapshotDigest } from "./sync-state.mjs";

test("snapshot digest ignores object key order but detects data changes", () => {
  const first = snapshotDigest({
    projects: [{ id: "project-1", name: "门店 A" }],
    costs: [],
  });
  const reordered = snapshotDigest({
    costs: [],
    projects: [{ name: "门店 A", id: "project-1" }],
  });
  const changed = snapshotDigest({
    projects: [{ id: "project-1", name: "门店 B" }],
    costs: [],
  });

  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});
