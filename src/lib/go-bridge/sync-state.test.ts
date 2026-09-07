import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertGoScopeSynced, nextRetryAt, summarizeSyncRows, type GoSyncRow } from "./sync-state";
import { GoScopeError } from "./scope";

const ERP_ID = "11111111-1111-4111-8111-111111111111";
const row = (o: Partial<GoSyncRow>): GoSyncRow => ({
  subject_type: "user_scope",
  subject_key: ERP_ID,
  change_kind: "update",
  status: "synced",
  attempts: 0,
  ...o,
});

describe("assertGoScopeSynced (fail closed on revocation)", () => {
  it("passes when everything is synced", () => {
    assertGoScopeSynced([row({}), row({ change_kind: "grant", status: "pending" })]);
  });

  it("refuses while a revocation is still pending", () => {
    try {
      assertGoScopeSynced([row({ change_kind: "revoke", status: "pending" })]);
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof GoScopeError);
      assert.equal(e.code, "scope_revocation_pending");
      assert.equal(e.status, 403);
    }
  });

  it("refuses when a revocation sync has failed (no indefinite old permission)", () => {
    try {
      assertGoScopeSynced([row({ change_kind: "revoke", status: "failed", attempts: 5 })]);
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof GoScopeError);
      assert.equal(e.code, "scope_revocation_failed");
    }
  });
});

describe("sync bookkeeping", () => {
  it("backs off retries and caps the delay", () => {
    const base = new Date("2026-09-07T00:00:00.000Z");
    assert.equal(nextRetryAt(0, base), new Date(base.getTime() + 30_000).toISOString());
    assert.equal(nextRetryAt(3, base), new Date(base.getTime() + 240_000).toISOString());
    assert.equal(nextRetryAt(50, base), new Date(base.getTime() + 900_000).toISOString());
  });

  it("summarizes per-subject status for the admin UI (never 'saved = effective')", () => {
    const s = summarizeSyncRows([
      row({ status: "pending", change_kind: "update" }),
      row({ subject_key: "go:shop-1", subject_type: "shop_link", status: "failed", attempts: 2 }),
      row({ subject_key: "other", status: "synced" }),
    ]);
    assert.equal(s.pending, 1);
    assert.equal(s.failed, 1);
    assert.equal(s.synced, 1);
    assert.equal(s.overall, "failed");
  });
});
