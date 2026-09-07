/**
 * 用户角色 / 门店范围配置（沿用现有「用户管理」，不新增后台）。
 *
 * 约定：
 *  - 角色枚举沿用既有 app_role，不新增、不改名。
 *  - HQ 是显式角色（super_admin / hq_operator），HQ 名下没有门店也能全局浏览；
 *    永远不能因为「没有门店」反推成 HQ。
 *  - 授权动作与浏览范围分开：门店范围只决定看得到什么，具体写操作仍由各业务接口自行校验。
 *  - 全部写操作幂等（重复提交同样的集合不会重复写），并落 user_scope_audit_logs 审计。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const ROLES = [
  "super_admin",
  "hq_operator",
  "store_manager",
  "store_staff",
  "warehouse_staff",
] as const;
export type ScopeRole = (typeof ROLES)[number];
export const HQ_ROLES: ScopeRole[] = ["super_admin", "hq_operator"];

type AuthedContext = {
  supabase: { auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> } };
  userId: string;
};

async function assertHqAdmin(context: AuthedContext) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabaseAdmin as unknown as { from: (t: string) => any };
  const { data } = await sb.from("user_roles").select("role").eq("user_id", context.userId);
  const roles = ((data as { role: string }[] | null) ?? []).map((r) => r.role);
  if (!roles.some((r) => (HQ_ROLES as string[]).includes(r))) {
    throw new Error("无权操作：仅总部管理员可配置角色与门店范围");
  }
  return {
    actorId: context.userId,
    actorRole: roles.includes("super_admin") ? "super_admin" : "hq_operator",
  };
}

/** 列出所有用户的角色与门店范围（供用户管理页展示） */
export const listUserScopesFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertHqAdmin(context as unknown as AuthedContext);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabaseAdmin as unknown as { from: (t: string) => any };

    const [{ data: roles }, { data: perms }, { data: locations }, { data: goLinks }] =
      await Promise.all([
        sb.from("user_roles").select("user_id, role"),
        sb.from("user_location_perms").select("user_id, location_id"),
        sb.from("inv_locations").select("id, name, kind, is_active").eq("is_active", true),
        sb.from("go_identity_links").select("erp_user_id, go_user_id, status, location_id"),
      ]);

    const roleRows = (roles as { user_id: string; role: string }[] | null) ?? [];
    const permRows = (perms as { user_id: string; location_id: string }[] | null) ?? [];
    const goRows =
      (goLinks as { erp_user_id: string | null; go_user_id: string; status: string }[] | null) ??
      [];

    const byUser = new Map<
      string,
      {
        user_id: string;
        roles: string[];
        location_ids: string[];
        is_hq: boolean;
        go_status: string | null;
      }
    >();
    const ensure = (userId: string) => {
      let row = byUser.get(userId);
      if (!row) {
        row = { user_id: userId, roles: [], location_ids: [], is_hq: false, go_status: null };
        byUser.set(userId, row);
      }
      return row;
    };
    for (const r of roleRows) ensure(r.user_id).roles.push(r.role);
    for (const p of permRows) ensure(p.user_id).location_ids.push(p.location_id);
    for (const g of goRows) if (g.erp_user_id) ensure(g.erp_user_id).go_status = g.status;
    for (const row of byUser.values()) {
      row.is_hq = row.roles.some((r) => (HQ_ROLES as string[]).includes(r));
    }

    return {
      users: [...byUser.values()],
      locations: ((locations as { id: string; name: string; kind: string }[] | null) ?? []).sort(
        (a, b) =>
          a.kind === b.kind
            ? a.name.localeCompare(b.name, "zh-Hans-CN")
            : a.kind === "warehouse"
              ? -1
              : 1,
      ),
      roles: ROLES,
    };
  });

const setRolesSchema = z.object({
  userId: z.string().uuid(),
  roles: z.array(z.enum(ROLES)).max(5),
  reason: z.string().trim().max(200).optional(),
});

/** 幂等覆盖角色集合 */
export const setUserRolesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => setRolesSchema.parse(i))
  .handler(async ({ data, context }) => {
    const actor = await assertHqAdmin(context as unknown as AuthedContext);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabaseAdmin as unknown as { from: (t: string) => any };

    const { data: beforeRows } = await sb
      .from("user_roles")
      .select("role")
      .eq("user_id", data.userId);
    const before = ((beforeRows as { role: string }[] | null) ?? []).map((r) => r.role).sort();
    const after = [...new Set(data.roles)].sort();

    if (
      data.userId === actor.actorId &&
      !after.includes("super_admin") &&
      before.includes("super_admin")
    ) {
      throw new Error("不能撤销自己的超级管理员角色");
    }

    const toAdd = after.filter((r) => !before.includes(r));
    const toRemove = before.filter((r) => !(after as string[]).includes(r));

    if (toRemove.length > 0) {
      const { error } = await sb
        .from("user_roles")
        .delete()
        .eq("user_id", data.userId)
        .in("role", toRemove);
      if (error) throw new Error(error.message);
    }
    if (toAdd.length > 0) {
      const { error } = await sb.from("user_roles").upsert(
        toAdd.map((role) => ({ user_id: data.userId, role })),
        { onConflict: "user_id,role" },
      );
      if (error) throw new Error(error.message);
    }

    if (toAdd.length > 0 || toRemove.length > 0) {
      await sb.from("user_scope_audit_logs").insert({
        target_user_id: data.userId,
        action: toAdd.length > 0 ? "grant_role" : "revoke_role",
        before_snapshot: { roles: before },
        after_snapshot: { roles: after, added: toAdd, removed: toRemove },
        reason: data.reason ?? null,
        actor_id: actor.actorId,
        actor_role: actor.actorRole,
      });
    }
    return {
      ok: true,
      roles: after,
      added: toAdd,
      removed: toRemove,
      changed: toAdd.length + toRemove.length > 0,
    };
  });

const setLocationsSchema = z.object({
  userId: z.string().uuid(),
  locationIds: z.array(z.string().uuid()).max(200),
  reason: z.string().trim().max(200).optional(),
});

/** 幂等覆盖门店范围；HQ 角色即使没有任何门店也保留全局浏览能力 */
export const setUserLocationsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => setLocationsSchema.parse(i))
  .handler(async ({ data, context }) => {
    const actor = await assertHqAdmin(context as unknown as AuthedContext);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabaseAdmin as unknown as { from: (t: string) => any };

    const wanted = [...new Set(data.locationIds)];
    if (wanted.length > 0) {
      const { data: valid } = await sb
        .from("inv_locations")
        .select("id")
        .in("id", wanted)
        .eq("is_active", true);
      const validIds = new Set(((valid as { id: string }[] | null) ?? []).map((r) => r.id));
      const invalid = wanted.filter((id) => !validIds.has(id));
      if (invalid.length > 0) throw new Error(`门店不存在或已停用：${invalid.join(", ")}`);
    }

    const { data: beforeRows } = await sb
      .from("user_location_perms")
      .select("location_id")
      .eq("user_id", data.userId);
    const before = ((beforeRows as { location_id: string }[] | null) ?? [])
      .map((r) => r.location_id)
      .sort();
    const after = [...wanted].sort();

    const toAdd = after.filter((id) => !before.includes(id));
    const toRemove = before.filter((id) => !after.includes(id));

    if (toRemove.length > 0) {
      const { error } = await sb
        .from("user_location_perms")
        .delete()
        .eq("user_id", data.userId)
        .in("location_id", toRemove);
      if (error) throw new Error(error.message);
    }
    if (toAdd.length > 0) {
      const { error } = await sb.from("user_location_perms").upsert(
        toAdd.map((location_id) => ({ user_id: data.userId, location_id })),
        { onConflict: "user_id,location_id" },
      );
      if (error) throw new Error(error.message);
    }

    if (toAdd.length > 0 || toRemove.length > 0) {
      await sb.from("user_scope_audit_logs").insert({
        target_user_id: data.userId,
        action: toAdd.length > 0 ? "grant_location" : "revoke_location",
        before_snapshot: { location_ids: before },
        after_snapshot: { location_ids: after, added: toAdd, removed: toRemove },
        reason: data.reason ?? null,
        actor_id: actor.actorId,
        actor_role: actor.actorRole,
      });
    }
    return {
      ok: true,
      location_ids: after,
      added: toAdd,
      removed: toRemove,
      changed: toAdd.length + toRemove.length > 0,
    };
  });

const goIdentitySchema = z.object({
  goProjectRef: z.string().trim().min(1),
  goUserId: z.string().trim().min(1),
  erpUserId: z.string().uuid(),
  status: z.enum(["approved", "revoked"]),
  reason: z.string().trim().max(200).optional(),
});

/** 审核 / 撤销 GO 身份绑定；必须显式给出双方 ERP user id，禁止按手机号自动关联 */
export const setGoIdentityLinkFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => goIdentitySchema.parse(i))
  .handler(async ({ data, context }) => {
    const actor = await assertHqAdmin(context as unknown as AuthedContext);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabaseAdmin as unknown as { from: (t: string) => any };

    const { data: before } = await sb
      .from("go_identity_links")
      .select("*")
      .eq("go_project_ref", data.goProjectRef)
      .eq("go_user_id", data.goUserId)
      .maybeSingle();

    const payload = {
      go_project_ref: data.goProjectRef,
      go_user_id: data.goUserId,
      erp_user_id: data.erpUserId,
      status: data.status,
      approved_by: data.status === "approved" ? actor.actorId : null,
      approved_at: data.status === "approved" ? new Date().toISOString() : null,
      revoked_at: data.status === "revoked" ? new Date().toISOString() : null,
    };
    const { data: after, error } = await sb
      .from("go_identity_links")
      .upsert(payload, { onConflict: "go_project_ref,go_user_id" })
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    await sb.from("user_scope_audit_logs").insert({
      target_user_id: data.erpUserId,
      action: data.status === "approved" ? "approve_go_identity" : "revoke_go_identity",
      before_snapshot: before ?? null,
      after_snapshot: after,
      reason: data.reason ?? null,
      actor_id: actor.actorId,
      actor_role: actor.actorRole,
    });
    return { ok: true, link: after };
  });

const goShopSchema = z.object({
  goProjectRef: z.string().trim().min(1),
  goShopId: z.string().trim().min(1),
  locationId: z.string().uuid(),
  status: z.enum(["active", "revoked"]).default("active"),
  reason: z.string().trim().max(200).optional(),
});

/** GO 门店 ↔ ERP 门店映射；没有 active 记录时员工在 GO 侧拿不到任何数据 */
export const setGoShopLinkFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => goShopSchema.parse(i))
  .handler(async ({ data, context }) => {
    const actor = await assertHqAdmin(context as unknown as AuthedContext);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabaseAdmin as unknown as { from: (t: string) => any };

    const { data: loc } = await sb
      .from("inv_locations")
      .select("id, kind, is_active")
      .eq("id", data.locationId)
      .maybeSingle();
    const location = loc as { kind: string; is_active: boolean } | null;
    if (!location || !location.is_active) throw new Error("门店不存在或已停用");
    if (location.kind !== "shop") throw new Error("只能映射到门店，不能映射到仓库");

    const { data: before } = await sb
      .from("go_shop_location_links")
      .select("*")
      .eq("go_project_ref", data.goProjectRef)
      .eq("go_shop_id", data.goShopId)
      .maybeSingle();

    const { data: after, error } = await sb
      .from("go_shop_location_links")
      .upsert(
        {
          go_project_ref: data.goProjectRef,
          go_shop_id: data.goShopId,
          location_id: data.locationId,
          status: data.status,
          updated_by: actor.actorId,
          created_by: actor.actorId,
        },
        { onConflict: "go_project_ref,go_shop_id" },
      )
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    await sb.from("user_scope_audit_logs").insert({
      target_user_id: actor.actorId,
      action: data.status === "active" ? "link_go_shop" : "unlink_go_shop",
      location_id: data.locationId,
      before_snapshot: before ?? null,
      after_snapshot: after,
      reason: data.reason ?? null,
      actor_id: actor.actorId,
      actor_role: actor.actorRole,
    });
    return { ok: true, link: after };
  });

export const listGoShopLinksFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertHqAdmin(context as unknown as AuthedContext);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabaseAdmin as unknown as { from: (t: string) => any };
    const { data } = await sb
      .from("go_shop_location_links")
      .select("id, go_project_ref, go_shop_id, location_id, status, updated_at");
    return (data ?? []) as {
      id: string;
      go_project_ref: string;
      go_shop_id: string;
      location_id: string;
      status: string;
      updated_at: string;
    }[];
  });
