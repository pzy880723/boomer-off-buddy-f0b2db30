/**
 * 角色 / 门店范围写操作的安全护栏（纯逻辑，可单测）。
 *
 * 铁律：
 *  - 权限管理动作只有 super_admin 能做；hq_operator 只能看，不能授权。
 *  - 不能给自己升 super_admin，也不能把自己的 super_admin 摘掉（避免自锁 / 自提权）。
 *  - 永远至少保留一个 super_admin。
 *  - 停用 / 已删除账号一律不允许写入范围。
 */
export class ScopeAdminError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 403) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function assertScopeAdmin(actorRoles: string[]): "super_admin" {
  if (!actorRoles.includes("super_admin")) {
    throw new ScopeAdminError("not_super_admin", "只有超级管理员可以配置角色与门店范围");
  }
  return "super_admin";
}

export function assertNoSelfEscalation(input: {
  actorId: string;
  targetUserId: string;
  before: string[];
  after: string[];
}): void {
  if (input.actorId !== input.targetUserId) return;
  const had = input.before.includes("super_admin");
  const will = input.after.includes("super_admin");
  if (!had && will) {
    throw new ScopeAdminError("self_escalation", "不能给自己授予超级管理员");
  }
  if (had && !will) {
    throw new ScopeAdminError("self_demotion", "不能撤销自己的超级管理员角色");
  }
}

export function assertNotLastSuperAdmin(input: {
  targetUserId: string;
  before: string[];
  after: string[];
  superAdminIds: string[];
}): void {
  const losing = input.before.includes("super_admin") && !input.after.includes("super_admin");
  if (!losing) return;
  const remaining = input.superAdminIds.filter((id) => id !== input.targetUserId);
  if (remaining.length === 0) {
    throw new ScopeAdminError("last_super_admin", "系统必须至少保留一个超级管理员");
  }
}

export function assertTargetWritable(
  target: { banned_until: string | null; deleted_at: string | null },
  now: Date,
): void {
  if (target.deleted_at) {
    throw new ScopeAdminError("target_disabled", "该账号已删除，无法配置范围");
  }
  if (target.banned_until && new Date(target.banned_until).getTime() > now.getTime()) {
    throw new ScopeAdminError("target_disabled", "该账号已停用，请先恢复账号再配置范围");
  }
}
