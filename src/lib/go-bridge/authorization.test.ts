import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildAuthorizationSnapshot,
  parseGoReceiptPayload,
  permissionsForRoles,
  GoReceiptError,
  type AuthorizationFacts,
} from "./authorization";

const SHOP = {
  go_shop_id: "go-1",
  erp_location_id: "11111111-1111-4111-8111-111111111111",
  name: "中信泰富店",
};

function facts(over: Partial<AuthorizationFacts> = {}): AuthorizationFacts {
  return {
    erp_user_id: "22222222-2222-4222-8222-222222222222",
    account_exists: true,
    banned: false,
    deleted: false,
    roles: ["store_staff"],
    location_ids: [SHOP.erp_location_id],
    identity_status: "active",
    shop_links: [SHOP],
    version: 1700000000000,
    generated_at: "2026-09-07T10:00:00.000Z",
    ...over,
  };
}

describe("buildAuthorizationSnapshot", () => {
  it("员工有可信映射 → ok，权限来自角色", () => {
    const snap = buildAuthorizationSnapshot(facts());
    assert.equal(snap.status, "ok");
    assert.equal(snap.active, true);
    assert.equal(snap.revoked, false);
    assert.equal(snap.is_hq, false);
    assert.deepEqual(snap.shops, [SHOP]);
    assert.deepEqual(snap.permissions, permissionsForRoles(["store_staff"]));
    assert.equal(snap.scope_version, 1700000000000);
  });

  it("HQ 没有门店映射目录仍然是 HQ", () => {
    const snap = buildAuthorizationSnapshot(
      facts({ roles: ["hq_operator"], location_ids: [], shop_links: [] }),
    );
    assert.equal(snap.is_hq, true);
    assert.equal(snap.status, "ok");
    assert.deepEqual(snap.shops, []);
    assert.ok(snap.permissions.includes("view_all_stores"));
  });

  it("员工缺映射 → 明确 unconfigured，但权限不被静默丢弃", () => {
    const snap = buildAuthorizationSnapshot(facts({ shop_links: [] }));
    assert.equal(snap.status, "unconfigured");
    assert.equal(snap.active, true);
    assert.deepEqual(snap.roles, ["store_staff"]);
    assert.ok(snap.permissions.length > 0);
    assert.ok(snap.reasons.includes("shop_mapping_unconfigured"));
  });

  it("员工没有任何门店授权 → unconfigured", () => {
    const snap = buildAuthorizationSnapshot(facts({ location_ids: [] }));
    assert.equal(snap.status, "unconfigured");
    assert.ok(snap.reasons.includes("no_location_permission"));
  });

  it("停用账号 → revoked 墓碑且不带任何权限", () => {
    const snap = buildAuthorizationSnapshot(facts({ banned: true }));
    assert.equal(snap.revoked, true);
    assert.equal(snap.active, false);
    assert.equal(snap.status, "revoked");
    assert.deepEqual(snap.roles, []);
    assert.deepEqual(snap.permissions, []);
  });

  it("身份绑定被撤销 → revoked 墓碑", () => {
    const snap = buildAuthorizationSnapshot(facts({ identity_status: "revoked" }));
    assert.equal(snap.revoked, true);
    assert.ok(snap.reasons.includes("identity_revoked"));
  });

  it("没有真实 ERP 账号 → 不授予任何权限", () => {
    const snap = buildAuthorizationSnapshot(facts({ account_exists: false }));
    assert.equal(snap.status, "no_erp_account");
    assert.deepEqual(snap.permissions, []);
    assert.equal(snap.revoked, true);
  });

  it("没有角色 → unconfigured 且无权限", () => {
    const snap = buildAuthorizationSnapshot(facts({ roles: [] }));
    assert.equal(snap.status, "unconfigured");
    assert.deepEqual(snap.permissions, []);
    assert.ok(snap.reasons.includes("no_erp_role"));
  });

  it("同一份授权版本稳定，不含随机 / 客户端时间", () => {
    assert.deepEqual(buildAuthorizationSnapshot(facts()), buildAuthorizationSnapshot(facts()));
  });
});

const NOW = new Date("2026-09-07T10:00:30.000Z");
const RECEIPT = {
  authenticated: true,
  user_id: "go-user-1",
  erp_user_id: "22222222-2222-4222-8222-222222222222",
  scope_version: 1700000000000,
  link_status: "applied",
  scope_synced_at: "2026-09-07T10:00:00.000Z",
};
const OPTS = {
  expectedGoUserId: "go-user-1",
  expectedErpUserId: "22222222-2222-4222-8222-222222222222",
  currentVersion: 1700000000000,
  now: NOW,
};

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GoReceiptError);
    assert.equal((e as GoReceiptError).code, code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("parseGoReceiptPayload", () => {
  it("合法回执通过", () => {
    assert.equal(parseGoReceiptPayload(RECEIPT, OPTS).scopeVersion, 1700000000000);
  });

  it("身份不符 → 403", () => {
    expectCode(
      () => parseGoReceiptPayload({ ...RECEIPT, user_id: "other" }, OPTS),
      "go_identity_mismatch",
    );
    expectCode(
      () =>
        parseGoReceiptPayload(
          { ...RECEIPT, erp_user_id: "33333333-3333-4333-8333-333333333333" },
          OPTS,
        ),
      "erp_identity_mismatch",
    );
  });

  it("旧版本回执不得确认新授权", () => {
    expectCode(
      () => parseGoReceiptPayload({ ...RECEIPT, scope_version: 1699999999999 }, OPTS),
      "receipt_version_stale",
    );
  });

  it("超过 60 秒的回执过期", () => {
    expectCode(
      () => parseGoReceiptPayload(RECEIPT, { ...OPTS, now: new Date("2026-09-07T10:01:31.000Z") }),
      "receipt_expired",
    );
  });

  it("GO 未应用 → 不确认", () => {
    expectCode(
      () => parseGoReceiptPayload({ ...RECEIPT, link_status: "pending" }, OPTS),
      "receipt_not_applied",
    );
  });

  it("未认证 → 401", () => {
    expectCode(
      () => parseGoReceiptPayload({ ...RECEIPT, authenticated: false }, OPTS),
      "invalid_go_token",
    );
  });
});
