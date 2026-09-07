import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ScopeAdminError,
  assertScopeAdmin,
  assertTargetWritable,
  assertNotLastSuperAdmin,
  assertNoSelfEscalation,
} from "./guards";

function expectError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ScopeAdminError, `expected ScopeAdminError, got ${String(e)}`);
    assert.equal((e as ScopeAdminError).code, code);
    return;
  }
  assert.fail(`expected throw ${code}`);
}

const SELF = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("assertScopeAdmin", () => {
  it("only super_admin may change roles or store scope", () => {
    expectError(() => assertScopeAdmin(["hq_operator"]), "not_super_admin");
    expectError(() => assertScopeAdmin(["store_manager"]), "not_super_admin");
    expectError(() => assertScopeAdmin([]), "not_super_admin");
    assert.equal(assertScopeAdmin(["super_admin", "hq_operator"]), "super_admin");
  });
});

describe("assertNoSelfEscalation", () => {
  it("blocks granting yourself super_admin", () => {
    expectError(
      () =>
        assertNoSelfEscalation({
          actorId: SELF,
          targetUserId: SELF,
          before: ["hq_operator"],
          after: ["hq_operator", "super_admin"],
        }),
      "self_escalation",
    );
  });

  it("blocks dropping your own super_admin", () => {
    expectError(
      () =>
        assertNoSelfEscalation({
          actorId: SELF,
          targetUserId: SELF,
          before: ["super_admin"],
          after: [],
        }),
      "self_demotion",
    );
  });

  it("allows unrelated changes to your own account and to others", () => {
    assertNoSelfEscalation({
      actorId: SELF,
      targetUserId: SELF,
      before: ["super_admin"],
      after: ["super_admin", "store_manager"],
    });
    assertNoSelfEscalation({
      actorId: SELF,
      targetUserId: OTHER,
      before: [],
      after: ["super_admin"],
    });
  });
});

describe("assertNotLastSuperAdmin", () => {
  it("refuses to remove the last super admin", () => {
    expectError(
      () =>
        assertNotLastSuperAdmin({
          targetUserId: OTHER,
          before: ["super_admin"],
          after: ["store_manager"],
          superAdminIds: [OTHER],
        }),
      "last_super_admin",
    );
  });

  it("allows removal while another super admin remains", () => {
    assertNotLastSuperAdmin({
      targetUserId: OTHER,
      before: ["super_admin"],
      after: [],
      superAdminIds: [OTHER, SELF],
    });
  });
});

describe("assertTargetWritable", () => {
  const now = new Date("2026-09-07T10:00:00.000Z");
  it("refuses any scope write on a disabled or deleted account", () => {
    expectError(
      () => assertTargetWritable({ banned_until: "2099-01-01T00:00:00Z", deleted_at: null }, now),
      "target_disabled",
    );
    expectError(
      () => assertTargetWritable({ banned_until: null, deleted_at: "2026-01-01T00:00:00Z" }, now),
      "target_disabled",
    );
  });

  it("allows writes when a past ban has expired", () => {
    assertTargetWritable({ banned_until: "2026-01-01T00:00:00Z", deleted_at: null }, now);
  });
});
