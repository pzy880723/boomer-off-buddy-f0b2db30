/**
 * ERP → GO 授权镜像同步状态（纯逻辑）。
 *
 * 规则：
 *  - 保存不等于生效：每一次角色 / 门店 / 停用 / 映射变更都产生一条待同步记录。
 *  - 撤销类变更必须 fail closed：只要还没 synced，就立即拒绝该账号的 GO 通道，
 *    不允许旧权限无限期存续。
 *  - 授予类变更 pending 不阻断（少给不多给）。
 */
import { GoScopeError } from "./scope";

export type GoSyncStatus = "pending" | "synced" | "failed";
export type GoSyncChangeKind = "grant" | "revoke" | "update";
export type GoSyncSubjectType = "user_scope" | "identity_link" | "shop_link";

export type GoSyncRow = {
  subject_type: GoSyncSubjectType;
  subject_key: string;
  change_kind: GoSyncChangeKind;
  status: GoSyncStatus;
  attempts: number;
};

export function assertGoScopeSynced(rows: GoSyncRow[]): void {
  const revokes = rows.filter((r) => r.change_kind === "revoke" && r.status !== "synced");
  if (revokes.length === 0) return;
  const failed = revokes.some((r) => r.status === "failed");
  throw new GoScopeError(
    failed ? "scope_revocation_failed" : "scope_revocation_pending",
    failed
      ? "权限撤销尚未在 GO 生效（同步失败），已按最小权限拒绝访问"
      : "权限变更正在同步中，请稍后重试",
    403,
  );
}

const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 900_000;

export function nextRetryAt(attempts: number, now = new Date()): string {
  const delay = Math.min(BASE_DELAY_MS * Math.pow(2, Math.max(0, attempts)), MAX_DELAY_MS);
  return new Date(now.getTime() + delay).toISOString();
}

export function summarizeSyncRows(rows: GoSyncRow[]) {
  const pending = rows.filter((r) => r.status === "pending").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const synced = rows.filter((r) => r.status === "synced").length;
  const overall: GoSyncStatus = failed > 0 ? "failed" : pending > 0 ? "pending" : "synced";
  return { pending, failed, synced, overall };
}
