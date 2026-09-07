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
import { assertScopeAdmin, assertTargetWritable } from "@/lib/user-scope/guards";
import { GO_PROJECT_REF } from "@/lib/go-bridge/constants";
import { summarizeSyncRows, type GoSyncRow } from "@/lib/go-bridge/sync-state";

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

/** 只读：HQ 角色即可查看范围配置 */
async function assertHqReader(context: AuthedContext) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabaseAdmin as unknown as { from: (t: string) => any };
  const { data, error } = await sb.from("user_roles").select("role").eq("user_id", context.userId);
  if (error) throw new Error(error.message);
  const roles = ((data as { role: string }[] | null) ?? []).map((r) => r.role);
  if (!roles.some((r) => (HQ_ROLES as string[]).includes(r))) {
    throw new Error("无权操作：仅总部管理员可查看角色与门店范围");
  }
  return { actorId: context.userId, roles };
}

/** 写操作：只有 super_admin；hq_operator 只能看不能授权 */
async function assertScopeWriter(context: AuthedContext) {
  const { roles, actorId } = await assertHqReader(context);
  assertScopeAdmin(roles);
  return { actorId, actorRole: "super_admin" as const };
}

/** 目标账号必须可写（未停用 / 未删除） */
async function assertTargetAccountWritable(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error || !data?.user) throw new Error("目标账号不存在");
  const u = data.user as unknown as Record<string, unknown>;
  assertTargetWritable(
    {
      banned_until: (u["banned_until"] as string | null) ?? null,
      deleted_at: (u["deleted_at"] as string | null) ?? null,
    },
    new Date(),
  );
}

/**
 * 角色 + 门店 + 审计 + GO 待同步登记，单事务写入。
 * roles / locationIds 传 null 表示「本维度保持数据库现值」，
 * 这样只改角色不会覆盖并发修改的门店，反之亦然。
 */
async function applyScopeAtomic(input: {
  actorId: string;
  actorRole: string;
  targetUserId: string;
  roles: string[] | null;
  locationIds: string[] | null;
  reason?: string | undefined;
}) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const sb = supabaseAdmin as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  const { data, error } = await sb.rpc("set_user_scope_atomic_v2", {
    p_actor_id: input.actorId,
    p_actor_role: input.actorRole,
    p_target_user_id: input.targetUserId,
    p_roles: input.roles,
    p_location_ids: input.locationIds,
    p_reason: input.reason ?? null,
    p_go_project_ref: GO_PROJECT_REF,
  });
  if (error) throw new Error(scopeErrorMessage(error.message));
  return (data ?? {}) as {
    ok: boolean;
    changed: boolean;
    roles: string[];
    location_ids: string[];
    sync_status: "pending" | "synced";
  };
}

/** 登记一条待同步到 GO 的授权变更（幂等）；失败要报错，不能假称已生效 */
async function enqueueGoSync(input: {
  subjectType: "identity" | "shop_link" | "user_scope";
  subjectKey: string;
  changeKind: "update" | "revoke";
  targetUserId: string | null;
  payload: Record<string, unknown>;
}): Promise<"pending"> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const sb = supabaseAdmin as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  const { error } = await sb.rpc("go_scope_enqueue_sync", {
    p_go_project_ref: GO_PROJECT_REF,
    p_subject_type: input.subjectType,
    p_subject_key: input.subjectKey,
    p_change_kind: input.changeKind,
    p_payload: input.payload,
    p_target_user_id: input.targetUserId,
  });
  if (error) throw new Error(`授权变更未能登记同步，请重试：${error.message}`);
  return "pending";
}

function scopeErrorMessage(raw: string): string {
  if (raw.includes("not_super_admin")) return "无权操作：仅超级管理员可配置角色与门店范围";
  if (raw.includes("self_escalation")) return "不能给自己授予超级管理员";
  if (raw.includes("self_demotion")) return "不能撤销自己的超级管理员角色";
  if (raw.includes("last_super_admin")) return "系统必须至少保留一个超级管理员";
  if (raw.includes("invalid_locations")) return "门店不存在或已停用";
  return raw;
}

/** 列出所有用户的角色与门店范围（供用户管理页展示） */
export const listUserScopesFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertHqReader(context as unknown as AuthedContext);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabaseAdmin as unknown as { from: (t: string) => any };

    // 每一次读取都检查 error：读失败必须报错，绝不能吞成"这个用户没有角色/没有门店"
    const [rolesRes, permsRes, locationsRes, goLinksRes, syncRes] = await Promise.all([
      sb.from("user_roles").select("user_id, role"),
      sb.from("user_location_perms").select("user_id, location_id"),
      sb.from("inv_locations").select("id, name, kind, is_active").eq("is_active", true),
      sb.from("go_identity_links").select("erp_user_id, go_user_id, status"),
      sb
        .from("go_scope_sync_outbox")
        .select("subject_type, subject_key, target_user_id, change_kind, status, attempts")
        .eq("go_project_ref", GO_PROJECT_REF),
    ]);
    for (const res of [rolesRes, permsRes, locationsRes, goLinksRes, syncRes] as {
      error: { message: string } | null;
    }[]) {
      if (res.error) throw new Error(`读取角色/门店范围失败：${res.error.message}`);
    }

    const roleRows = (rolesRes.data as { user_id: string; role: string }[] | null) ?? [];
    const permRows = (permsRes.data as { user_id: string; location_id: string }[] | null) ?? [];
    const goRows =
      (goLinksRes.data as
        | { erp_user_id: string | null; go_user_id: string; status: string }[]
        | null) ?? [];
    const syncRows =
      (syncRes.data as
        | {
            subject_type: GoSyncRow["subject_type"];
            subject_key: string;
            target_user_id: string | null;
            change_kind: GoSyncRow["change_kind"];
            status: GoSyncRow["status"];
            attempts: number;
          }[]
        | null) ?? [];

    const byUser = new Map<
      string,
      {
        user_id: string;
        roles: string[];
        location_ids: string[];
        is_hq: boolean;
        go_status: string | null;
        go_sync_status: "pending" | "synced" | "failed";
        go_sync_attempts: number;
      }
    >();
    const ensure = (userId: string) => {
      let row = byUser.get(userId);
      if (!row) {
        row = {
          user_id: userId,
          roles: [],
          location_ids: [],
          is_hq: false,
          go_status: null,
          go_sync_status: "synced",
          go_sync_attempts: 0,
        };
        byUser.set(userId, row);
      }
      return row;
    };
    for (const r of roleRows) ensure(r.user_id).roles.push(r.role);
    for (const p of permRows) ensure(p.user_id).location_ids.push(p.location_id);
    for (const g of goRows) if (g.erp_user_id) ensure(g.erp_user_id).go_status = g.status;
    const syncByUser = new Map<string, GoSyncRow[]>();
    for (const s of syncRows) {
      if (!s.target_user_id) continue;
      const list = syncByUser.get(s.target_user_id) ?? [];
      list.push({
        subject_type: s.subject_type,
        subject_key: s.subject_key,
        change_kind: s.change_kind,
        status: s.status,
        attempts: s.attempts,
      });
      syncByUser.set(s.target_user_id, list);
    }
    for (const [userId, list] of syncByUser) {
      const row = ensure(userId);
      row.go_sync_status = summarizeSyncRows(list).overall;
      row.go_sync_attempts = list.reduce((m, r) => Math.max(m, r.attempts), 0);
    }
    for (const row of byUser.values()) {
      row.is_hq = row.roles.some((r) => (HQ_ROLES as string[]).includes(r));
    }

    return {
      users: [...byUser.values()],
      locations: (
        (locationsRes.data as { id: string; name: string; kind: string }[] | null) ?? []
      ).sort((a, b) =>
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
    const actor = await assertScopeWriter(context as unknown as AuthedContext);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabaseAdmin as unknown as { from: (t: string) => any };

    await assertTargetAccountWritable(data.userId);

    const beforeRes = await sb.from("user_roles").select("role").eq("user_id", data.userId);
    if (beforeRes.error) throw new Error(`读取当前角色失败：${beforeRes.error.message}`);
    const before = ((beforeRes.data as { role: string }[] | null) ?? []).map((r) => r.role).sort();
    const after = [...new Set(data.roles)].sort();

    const toAdd = after.filter((r) => !before.includes(r));
    const toRemove = before.filter((r) => !(after as string[]).includes(r));

    // 只提交角色维度：门店由数据库内部保持现值，避免并发编辑互相覆盖
    const result = await applyScopeAtomic({
      actorId: actor.actorId,
      actorRole: actor.actorRole,
      targetUserId: data.userId,
      roles: after,
      locationIds: null,
      reason: data.reason,
    });

    return {
      ok: true,
      roles: result.roles ?? after,
      added: toAdd,
      removed: toRemove,
      changed: Boolean(result.changed),
      sync_status: result.sync_status ?? "synced",
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
    const actor = await assertScopeWriter(context as unknown as AuthedContext);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabaseAdmin as unknown as { from: (t: string) => any };

    await assertTargetAccountWritable(data.userId);

    const wanted = [...new Set(data.locationIds)];
    const beforeRes = await sb
      .from("user_location_perms")
      .select("location_id")
      .eq("user_id", data.userId);
    if (beforeRes.error) throw new Error(`读取当前门店范围失败：${beforeRes.error.message}`);
    const before = ((beforeRes.data as { location_id: string }[] | null) ?? [])
      .map((r) => r.location_id)
      .sort();
    const after = [...wanted].sort();

    const toAdd = after.filter((id) => !before.includes(id));
    const toRemove = before.filter((id) => !after.includes(id));

    // 只提交门店维度：角色由数据库内部保持现值
    const result = await applyScopeAtomic({
      actorId: actor.actorId,
      actorRole: actor.actorRole,
      targetUserId: data.userId,
      roles: null,
      locationIds: after,
      reason: data.reason,
    });

    return {
      ok: true,
      location_ids: result.location_ids ?? after,
      added: toAdd,
      removed: toRemove,
      changed: Boolean(result.changed),
      sync_status: result.sync_status ?? "synced",
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
    const actor = await assertScopeWriter(context as unknown as AuthedContext);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabaseAdmin as unknown as { from: (t: string) => any };

    const beforeRes = await sb
      .from("go_identity_links")
      .select("*")
      .eq("go_project_ref", data.goProjectRef)
      .eq("go_user_id", data.goUserId)
      .maybeSingle();
    if (beforeRes.error) throw new Error(`读取现有绑定失败：${beforeRes.error.message}`);
    const before = beforeRes.data;

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

    const { error: auditError } = await sb.from("user_scope_audit_logs").insert({
      target_user_id: data.erpUserId,
      action: data.status === "approved" ? "approve_go_identity" : "revoke_go_identity",
      before_snapshot: before ?? null,
      after_snapshot: after,
      reason: data.reason ?? null,
      actor_id: actor.actorId,
      actor_role: actor.actorRole,
    });
    if (auditError) throw new Error(auditError.message);

    // 身份绑定变更必须同步回 GO；撤销在同步成功前 fail closed
    const syncStatus = await enqueueGoSync({
      subjectType: "identity",
      subjectKey: `${data.goProjectRef}:${data.goUserId}`,
      changeKind: data.status === "revoked" ? "revoke" : "update",
      targetUserId: data.erpUserId,
      payload: { go_user_id: data.goUserId, status: data.status },
    });
    return { ok: true, link: after, sync_status: syncStatus };
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
    const actor = await assertScopeWriter(context as unknown as AuthedContext);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabaseAdmin as unknown as { from: (t: string) => any };

    const locRes = await sb
      .from("inv_locations")
      .select("id, kind, is_active")
      .eq("id", data.locationId)
      .maybeSingle();
    if (locRes.error) throw new Error(`读取门店失败：${locRes.error.message}`);
    const location = locRes.data as { kind: string; is_active: boolean } | null;
    if (!location || !location.is_active) throw new Error("门店不存在或已停用");
    if (location.kind !== "shop") throw new Error("只能映射到门店，不能映射到仓库");

    const beforeRes = await sb
      .from("go_shop_location_links")
      .select("*")
      .eq("go_project_ref", data.goProjectRef)
      .eq("go_shop_id", data.goShopId)
      .maybeSingle();
    if (beforeRes.error) throw new Error(`读取现有门店映射失败：${beforeRes.error.message}`);
    const before = beforeRes.data;

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

    const { error: auditError } = await sb.from("user_scope_audit_logs").insert({
      target_user_id: actor.actorId,
      action: data.status === "active" ? "link_go_shop" : "unlink_go_shop",
      location_id: data.locationId,
      before_snapshot: before ?? null,
      after_snapshot: after,
      reason: data.reason ?? null,
      actor_id: actor.actorId,
      actor_role: actor.actorRole,
    });
    if (auditError) throw new Error(auditError.message);

    const syncStatus = await enqueueGoSync({
      subjectType: "shop_link",
      subjectKey: `${data.goProjectRef}:${data.goShopId}`,
      changeKind: data.status === "revoked" ? "revoke" : "update",
      targetUserId: null,
      payload: {
        go_shop_id: data.goShopId,
        erp_location_id: data.locationId,
        status: data.status,
      },
    });
    return { ok: true, link: after, sync_status: syncStatus };
  });

export const listGoShopLinksFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertHqReader(context as unknown as AuthedContext);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabaseAdmin as unknown as { from: (t: string) => any };
    const { data, error } = await sb
      .from("go_shop_location_links")
      .select("id, go_project_ref, go_shop_id, location_id, status, updated_at");
    if (error) throw new Error(`读取门店映射失败：${error.message}`);
    return (data ?? []) as {
      id: string;
      go_project_ref: string;
      go_shop_id: string;
      location_id: string;
      status: string;
      updated_at: string;
    }[];
  });
