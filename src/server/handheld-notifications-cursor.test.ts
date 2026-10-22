import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChangeCursor, parseListCursor, shouldReconcileSyncFailures } from "./handheld-notifications-cursor";

test("parses v2 change cursor and latest", () => {
  assert.equal(parseChangeCursor("latest"), "latest");
  assert.deepEqual(parseChangeCursor("v2:812:44"), { xid: "812", seq: 44 });
  for (const bad of ["v2:x:1", "v1:1:1", "v2:1", "2026-01-01T00:00:00Z", "v2:1:1;drop"]) assert.equal(parseChangeCursor(bad), null);
});
test("parses composite list cursor; legacy ts stays legacy", () => {
  assert.deepEqual(parseListCursor("2026-01-01T00:00:00.000Z|00000000-0000-0000-0000-0000000000a1"), {
    ts: "2026-01-01T00:00:00.000Z", id: "00000000-0000-0000-0000-0000000000a1" });
  assert.equal(parseListCursor("2026-01-01T00:00:00.000Z"), null);
  assert.equal(parseListCursor("2026-01-01T00:00:00Z|x),or(id.gt.0"), null);
});

test("list cursor preserves microsecond precision (no Date round-trip)", () => {
  const c = parseListCursor("2026-10-22T13:44:34.918254+00:00|00000000-0000-0000-0000-0000000000a1");
  assert.deepEqual(c, { ts: "2026-10-22T13:44:34.918254+00:00", id: "00000000-0000-0000-0000-0000000000a1" });
  // 同一毫秒内不同微秒的行不能被游标截断丢失
  const c2 = parseListCursor("2026-10-22T13:44:34.918999Z|00000000-0000-0000-0000-0000000000a2");
  assert.equal(c2?.ts, "2026-10-22T13:44:34.918999Z");
});

test("sync failure reconcile only on first page of all/system category", () => {
  // 首次页 + 无分类 → 触发
  assert.equal(shouldReconcileSyncFailures(null, undefined), true);
  assert.equal(shouldReconcileSyncFailures(undefined, null), true);
  // 首次页 + system 分类 → 触发
  assert.equal(shouldReconcileSyncFailures(null, "system"), true);
  // 后续分页（有游标）→ 不触发，即使 system 分类
  assert.equal(shouldReconcileSyncFailures("2026-10-22T13:44:34.918254+00:00|00000000-0000-0000-0000-0000000000a1", "system"), false);
  assert.equal(shouldReconcileSyncFailures("2026-10-22T13:44:34.918254+00:00", undefined), false);
  // 其他分类 → 不触发
  assert.equal(shouldReconcileSyncFailures(null, "customers"), false);
  assert.equal(shouldReconcileSyncFailures(null, "orders"), false);
  assert.equal(shouldReconcileSyncFailures(null, "internal"), false);
});
