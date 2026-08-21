import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

const routeUrl = new URL("../../routes/operations.members.tsx", import.meta.url);
const sidebarUrl = new URL("../../components/app-sidebar.tsx", import.meta.url);
const functionsUrl = new URL("./membership-admin.functions.ts", import.meta.url);
const migrationUrl = new URL(
  "../../../supabase/migrations/20260821150000_membership_admin_operations.sql",
  import.meta.url,
);

describe("ERP membership administration contract", () => {
  test("exposes the approved operations navigation and six management sections", () => {
    assert.equal(existsSync(routeUrl), true, "会员管理路由尚未创建");
    const route = readFileSync(routeUrl, "utf8");
    const sidebar = readFileSync(sidebarUrl, "utf8");

    assert.match(sidebar, /会员管理/);
    assert.match(sidebar, /operations\/members/);
    for (const label of ["会员列表", "会员方案", "优惠券", "积分账本", "消费记录", "变更审计"]) {
      assert.match(route, new RegExp(label));
    }
  });

  test("keeps admin reads authenticated and mutations super-admin audited", () => {
    assert.equal(existsSync(functionsUrl), true, "会员后台服务函数尚未创建");
    const source = readFileSync(functionsUrl, "utf8");

    assert.match(source, /requireSupabaseAuth/);
    assert.match(source, /has_role/);
    assert.match(source, /super_admin/);
    assert.match(source, /commerce_admin_adjust_membership/);
    assert.match(source, /reason:\s*z\.string\(\)\.trim\(\)\.min\(2/);
    assert.match(source, /idempotency_key/);
  });

  test("requires transactional audit rows for every manual adjustment", () => {
    assert.equal(existsSync(migrationUrl), true, "会员后台审计迁移尚未创建");
    const migration = readFileSync(migrationUrl, "utf8");

    assert.match(migration, /CREATE TABLE public\.commerce_membership_admin_audit_logs/i);
    assert.match(migration, /CREATE OR REPLACE FUNCTION public\.commerce_admin_adjust_membership/i);
    assert.match(migration, /p_reason text/i);
    assert.match(migration, /reason is required/i);
    assert.match(migration, /idempotency_key text NOT NULL UNIQUE/i);
    assert.match(migration, /INSERT INTO public\.commerce_membership_admin_audit_logs/i);
    assert.match(migration, /REVOKE ALL ON FUNCTION public\.commerce_admin_adjust_membership/i);
  });
});
