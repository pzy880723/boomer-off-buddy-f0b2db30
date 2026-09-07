import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildAuthorizationSnapshot,
  expectedLinkStatus,
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
const SHOP2 = {
  go_shop_id: "go-2",
  erp_location_id: "33333333-3333-4333-8333-333333333333",
  name: "朔门古港店",
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
    version: 7,
    generated_at: "2026-09-07T10:00:00.000Z",
    ...over,
  };
}

describe("permissionsForRoles（GO 真实动作键）", () => {
  it("store_staff 保持既有 11 项，且不含任何管理员动作", () => {
    const perms = permissionsForRoles(["store_staff"]);
    assert.deepEqual(perms, [
      "community.post",
      "knowledge.official.read",
      "knowledge.personal.write",
      "price.write",
      "product.create",
      "product.edit",
      "recognition.use",
      "schedule.view_self",
      "schedule.view_shop",
      "shop.kb.read",
      "voucher.redeem",
    ]);
    for (const admin of [
      "role.manage",
      "user.update_role",
      "user.suspend",
      "settings.ai",
      "shop.write",
      "schedule.write",
    ]) {
      assert.equal(perms.includes(admin), false, admin);
    }
  });

  it("super_admin 覆盖 GO 全部 37 个动作键", () => {
    const perms = permissionsForRoles(["super_admin"]);
    assert.equal(perms.length, 37);
    for (const key of [
      "knowledge.official.read",
      "knowledge.official.write",
      "knowledge.personal.write",
      "recognition.use",
      "role.manage",
      "settings.recognition",
      "user.reset_password",
      "voucher.manage",
    ]) {
      assert.equal(perms.includes(key), true, key);
    }
  });

  it("store_manager 有排班/审核等管理动作，但没有全局 role.manage / user 管理", () => {
    const perms = permissionsForRoles(["store_manager"]);
    assert.equal(perms.includes("schedule.write"), true);
    assert.equal(perms.includes("staff.write"), true);
    assert.equal(perms.includes("shop.kb.write"), true);
    assert.equal(perms.includes("role.manage"), false);
    assert.equal(perms.includes("user.update_role"), false);
    assert.equal(perms.includes("user.create"), false);
    assert.equal(perms.includes("settings.ai"), false);
  });

  it("hq_operator 有知识库/拍照/排班读取，但不冒充 super_admin", () => {
    const perms = permissionsForRoles(["hq_operator"]);
    assert.equal(perms.includes("knowledge.official.read"), true);
    assert.equal(perms.includes("knowledge.official.write"), true);
    assert.equal(perms.includes("recognition.use"), true);
    assert.equal(perms.includes("schedule.view_shop"), true);
    assert.equal(perms.includes("role.manage"), false);
    assert.equal(perms.includes("schedule.write"), false);
    assert.equal(perms.includes("user.suspend"), false);
  });

  it("知识库与拍照识别权限不会因为镜像刷新而丢失", () => {
    for (const role of ["super_admin", "hq_operator", "store_manager", "store_staff"]) {
      const perms = permissionsForRoles([role]);
      assert.equal(perms.includes("knowledge.official.read"), true, role);
      assert.equal(perms.includes("recognition.use"), true, role);
    }
  });

  it("未知角色不产生任何权限", () => {
    assert.deepEqual(permissionsForRoles(["mystery_role"]), []);
  });
});

describe("buildAuthorizationSnapshot", () => {
  it("员工映射完整 → ok + 真实动作权限", () => {
    const snap = buildAuthorizationSnapshot(facts());
    assert.equal(snap.status, "ok");
    assert.equal(snap.active, true);
    assert.equal(snap.revoked, false);
    assert.equal(snap.is_hq, false);
    assert.deepEqual(snap.shops, [SHOP]);
    assert.equal(snap.permissions.includes("recognition.use"), true);
    assert.equal(snap.scope_version, 7);
  });

  it("员工缺任一映射 → 安全阻断整份 scope（无部分授权）", () => {
    const snap = buildAuthorizationSnapshot(
      facts({ location_ids: [SHOP.erp_location_id, SHOP2.erp_location_id] }),
    );
    assert.equal(snap.status, "unconfigured");
    assert.equal(snap.active, false);
    assert.equal(snap.revoked, false);
    assert.deepEqual(snap.shops, []);
    assert.deepEqual(snap.permissions, []);
    assert.deepEqual(snap.roles, []);
    assert.equal(snap.reasons.includes("shop_mapping_unconfigured"), true);
    assert.equal(snap.reasons.includes(`unmapped_location:${SHOP2.erp_location_id}`), true);
  });

  it("员工无门店授权 → unconfigured 且零权限", () => {
    const snap = buildAuthorizationSnapshot(facts({ location_ids: [] }));
    assert.equal(snap.status, "unconfigured");
    assert.deepEqual(snap.permissions, []);
    assert.deepEqual(snap.shops, []);
  });

  it("HQ 无门店映射仍是 HQ，权限保留", () => {
    const snap = buildAuthorizationSnapshot(
      facts({ roles: ["super_admin"], location_ids: [], shop_links: [] }),
    );
    assert.equal(snap.is_hq, true);
    assert.equal(snap.status, "ok");
    assert.equal(snap.permissions.length, 37);
    assert.deepEqual(snap.reasons, ["shop_directory_empty"]);
  });

  it("停用 / 删除 / 绑定撤销 → revoked 墓碑且零权限", () => {
    for (const [over, reason] of [
      [{ banned: true }, "erp_account_disabled"],
      [{ deleted: true }, "erp_account_deleted"],
      [{ identity_status: "revoked" }, "identity_revoked"],
    ] as const) {
      const snap = buildAuthorizationSnapshot(facts(over));
      assert.equal(snap.status, "revoked");
      assert.equal(snap.revoked, true);
      assert.equal(snap.active, false);
      assert.deepEqual(snap.permissions, []);
      assert.equal(snap.reasons.includes(reason), true);
    }
  });

  it("无真实 ERP 账号 → no_erp_account，零权限", () => {
    const snap = buildAuthorizationSnapshot(facts({ account_exists: false }));
    assert.equal(snap.status, "no_erp_account");
    assert.equal(snap.revoked, true);
    assert.deepEqual(snap.permissions, []);
  });

  it("有账号但无角色 → unconfigured，不撤销也不授权", () => {
    const snap = buildAuthorizationSnapshot(facts({ roles: [] }));
    assert.equal(snap.status, "unconfigured");
    assert.equal(snap.revoked, false);
    assert.deepEqual(snap.permissions, []);
  });
});

// ------------------------------------------------------------ 回执

const GO_UID = "go-user-1";
const ERP_UID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-07T10:00:30.000Z");

function receipt(over: Record<string, unknown> = {}) {
  return {
    authenticated: true,
    user_id: GO_UID,
    erp_user_id: ERP_UID,
    scope_version: 7,
    link_status: "active",
    scope_synced_at: "2026-09-07T10:00:00.000Z",
    ...over,
  };
}

function parse(raw: unknown, over: Partial<Parameters<typeof parseGoReceiptPayload>[1]> = {}) {
  return parseGoReceiptPayload(raw, {
    expectedGoUserId: GO_UID,
    expectedErpUserId: ERP_UID,
    currentVersion: 7,
    expectedLinkStatus: "active",
    now: NOW,
    ...over,
  });
}

describe("parseGoReceiptPayload", () => {
  it("active 回执 + 版本一致 → 通过", () => {
    const parsed = parse(receipt());
    assert.equal(parsed.linkStatus, "active");
    assert.equal(parsed.scopeVersion, 7);
  });

  it("revoked 快照期望 revoked 回执", () => {
    const parsed = parse(receipt({ link_status: "revoked" }), { expectedLinkStatus: "revoked" });
    assert.equal(parsed.linkStatus, "revoked");
  });

  it("同 version 但 revoked 回执不能确认 active 授权", () => {
    assert.throws(
      () => parse(receipt({ link_status: "revoked" })),
      (e: GoReceiptError) => e.code === "receipt_status_mismatch",
    );
  });

  it("active 回执不能确认 revoked 墓碑", () => {
    assert.throws(
      () => parse(receipt(), { expectedLinkStatus: "revoked" }),
      (e: GoReceiptError) => e.code === "receipt_status_mismatch",
    );
  });

  it("applied 是 apply 结果码，不是镜像状态 → 拒绝", () => {
    assert.throws(
      () => parse(receipt({ link_status: "applied" })),
      (e: GoReceiptError) => e.code === "receipt_status_invalid",
    );
  });

  it("未认证 / 身份不符 / ERP 不符 → 拒绝", () => {
    assert.throws(
      () => parse(receipt({ authenticated: false })),
      (e: GoReceiptError) => e.code === "invalid_go_token",
    );
    assert.throws(
      () => parse(receipt({ user_id: "other" })),
      (e: GoReceiptError) => e.code === "go_identity_mismatch",
    );
    assert.throws(
      () => parse(receipt({ erp_user_id: "44444444-4444-4444-8444-444444444444" })),
      (e: GoReceiptError) => e.code === "erp_identity_mismatch",
    );
  });

  it("旧版本回执 → stale", () => {
    assert.throws(
      () => parse(receipt({ scope_version: 6 })),
      (e: GoReceiptError) => e.code === "receipt_version_stale",
    );
  });

  it("超过 60 秒 → 过期", () => {
    assert.throws(
      () => parse(receipt({ scope_synced_at: "2026-09-07T09:59:00.000Z" })),
      (e: GoReceiptError) => e.code === "receipt_expired",
    );
  });

  it("空 payload → 不可用", () => {
    assert.throws(() => parse(null), (e: GoReceiptError) => e.code === "receipt_unavailable");
  });
});

describe("expectedLinkStatus", () => {
  it("按当前快照推导期望镜像状态", () => {
    assert.equal(expectedLinkStatus(buildAuthorizationSnapshot(facts())), "active");
    assert.equal(
      expectedLinkStatus(buildAuthorizationSnapshot(facts({ banned: true }))),
      "revoked",
    );
  });
});
