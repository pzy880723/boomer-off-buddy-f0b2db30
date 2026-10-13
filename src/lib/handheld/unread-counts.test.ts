import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUnreadCounts } from "./unread-counts";
import { buildHandheldOpenApi } from "./openapi";

const good = { customers: 3, internal: 2, orders: 602, system: 2, total: 609 };

test("valid counts pass (bigint strings accepted)", () => {
  assert.deepEqual(parseUnreadCounts(good), { ok: true, data: good });
  assert.equal(parseUnreadCounts({ ...good, orders: "602" }).ok, true);
});

test("invalid counts are contract errors, never zeroed", () => {
  const { total: _t, ...missing } = good;
  for (const bad of [
    null, [], "x", missing, { ...good, orders: -1 }, { ...good, orders: 1.5 }, { ...good, orders: NaN },
    { ...good, orders: "abc" }, { ...good, orders: 2 ** 60 }, { ...good, customers: undefined }, { ...good, total: 608 },
  ]) {
    const r = parseUnreadCounts(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test("OpenAPI documents GET unread-counts", () => {
  const op = buildHandheldOpenApi().paths?.["/api/public/handheld/notifications/unread-counts"]?.get;
  assert.ok(op?.responses?.["200"]);
  for (const k of ["customers", "orders", "internal", "system", "total", "location_forbidden", "unread_counts_contract_error", "last_read_at"])
    assert.match(String(op?.description), new RegExp(k));
});
