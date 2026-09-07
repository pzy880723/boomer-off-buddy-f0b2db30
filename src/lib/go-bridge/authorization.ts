/**
 * GO ← ERP 授权刷新通道（纯逻辑，可单测，不访问数据库 / 不解析 token）。
 *
 * 铁律：
 *  - 这是「授权刷新」通道：不能因为 GO 旧 scope / 租约过期 / 休息 / 已撤销镜像而挡住刷新，
 *    否则 GO 永远拿不到新授权（scope_stale 死循环）。
 *  - 唯一可信身份来自 GO 无参 RPC 返回的 erp_user_id；不接受任何客户端传入的 ERP ID，
 *    也绝不按姓名 / 手机号关联。
 *  - HQ 无需门店授权：显式 HQ 角色即使 shops 为空仍是 HQ。
 *  - 员工缺任意有效映射 → 明确 unconfigured，不静默丢权限。
 *  - 停用 / 撤销 → 返回可信 revoked 状态（供 GO 写墓碑），不是只 403 让旧镜像留存。
 *  - scope_version 由数据库快照给出（单调、同份授权稳定），绝不用客户端时间 / 随机值。
 */

export type AuthorizationStatus = "ok" | "unconfigured" | "revoked" | "no_erp_account";

export type AuthorizationShop = {
  go_shop_id: string;
  erp_location_id: string;
  name: string;
};

export type AuthorizationFacts = {
  erp_user_id: string;
  account_exists: boolean;
  banned: boolean;
  deleted: boolean;
  roles: string[];
  location_ids: string[];
  /** go_identity_links 中该 GO 账号的状态；无记录为 null（不构成阻断） */
  identity_status: string | null;
  /** 全量 active 门店映射目录（ERP 唯一真源） */
  shop_links: AuthorizationShop[];
  /** 数据库快照版本（毫秒级单调整数） */
  version: number;
  generated_at: string;
};

export type AuthorizationSnapshot = {
  erp_user_id: string;
  active: boolean;
  revoked: boolean;
  status: AuthorizationStatus;
  roles: string[];
  permissions: string[];
  is_hq: boolean;
  scope_version: number;
  updated_at: string;
  shops: AuthorizationShop[];
  reasons: string[];
};

const HQ_ROLES = new Set(["super_admin", "hq_operator"]);

/** 角色 → 动作权限（ERP 是唯一真源，GO 只镜像） */
const ROLE_PERMISSIONS: Record<string, string[]> = {
  super_admin: [
    "view_all_stores",
    "view_store_reports",
    "manage_store_targets",
    "record_offline_sales",
    "manage_users",
  ],
  hq_operator: [
    "view_all_stores",
    "view_store_reports",
    "manage_store_targets",
    "record_offline_sales",
  ],
  store_manager: ["view_own_store", "view_store_reports", "record_offline_sales"],
  store_staff: ["view_own_store", "record_offline_sales"],
  warehouse_staff: ["view_own_store"],
};

export function permissionsForRoles(roles: string[]): string[] {
  const out = new Set<string>();
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role] ?? []) out.add(p);
  return [...out].sort();
}

export function buildAuthorizationSnapshot(facts: AuthorizationFacts): AuthorizationSnapshot {
  const reasons: string[] = [];
  const base = {
    erp_user_id: facts.erp_user_id,
    scope_version: facts.version,
    updated_at: facts.generated_at,
  };

  // 1) 没有真实 ERP 账号 → 一律不授予任何权限
  if (!facts.account_exists) {
    return {
      ...base,
      active: false,
      revoked: true,
      status: "no_erp_account",
      roles: [],
      permissions: [],
      is_hq: false,
      shops: [],
      reasons: ["erp_account_missing"],
    };
  }

  // 2) 停用 / 删除 / 显式撤销绑定 → 可信 revoked 墓碑
  const revokedReasons: string[] = [];
  if (facts.banned) revokedReasons.push("erp_account_disabled");
  if (facts.deleted) revokedReasons.push("erp_account_deleted");
  if (facts.identity_status === "revoked") revokedReasons.push("identity_revoked");
  if (revokedReasons.length > 0) {
    return {
      ...base,
      active: false,
      revoked: true,
      status: "revoked",
      roles: [],
      permissions: [],
      is_hq: false,
      shops: [],
      reasons: revokedReasons,
    };
  }

  const roles = [...facts.roles].sort();
  if (roles.length === 0) {
    return {
      ...base,
      active: false,
      revoked: false,
      status: "unconfigured",
      roles: [],
      permissions: [],
      is_hq: false,
      shops: [],
      reasons: ["no_erp_role"],
    };
  }

  const isHq = roles.some((r) => HQ_ROLES.has(r));
  const permissions = permissionsForRoles(roles);

  // 3) HQ：无需门店授权，目录可为空仍是 HQ
  if (isHq) {
    if (facts.shop_links.length === 0) reasons.push("shop_directory_empty");
    return {
      ...base,
      active: true,
      revoked: false,
      status: "ok",
      roles,
      permissions,
      is_hq: true,
      shops: [...facts.shop_links].sort((a, b) => a.go_shop_id.localeCompare(b.go_shop_id)),
      reasons,
    };
  }

  // 4) 员工：只下发本人授权门店的既有可信映射
  const byLocation = new Map(facts.shop_links.map((s) => [s.erp_location_id, s]));
  const shops: AuthorizationShop[] = [];
  const unmapped: string[] = [];
  for (const locationId of facts.location_ids) {
    const mapped = byLocation.get(locationId);
    if (mapped) shops.push(mapped);
    else unmapped.push(locationId);
  }
  shops.sort((a, b) => a.go_shop_id.localeCompare(b.go_shop_id));

  if (facts.location_ids.length === 0) {
    reasons.push("no_location_permission");
  }
  if (unmapped.length > 0) {
    reasons.push("shop_mapping_unconfigured");
    for (const id of unmapped) reasons.push(`unmapped_location:${id}`);
  }
  const unconfigured = facts.location_ids.length === 0 || unmapped.length > 0;

  return {
    ...base,
    active: true,
    revoked: false,
    status: unconfigured ? "unconfigured" : "ok",
    roles,
    permissions,
    is_hq: false,
    shops,
    reasons,
  };
}

// ------------------------------------------------------------ 回执（ack）校验

export const RECEIPT_MAX_AGE_MS = 60_000;
/** 允许的时钟前偏（GO 时钟略快时不误杀） */
const RECEIPT_MAX_SKEW_MS = 5_000;

export type GoReceipt = {
  goUserId: string;
  erpUserId: string;
  scopeVersion: number;
  linkStatus: string;
  syncedAt: string;
};

export class GoReceiptError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * 消费 GO 无参 RPC `erp_scope_sync_receipt_v1()` 的可信回执。
 * 只信 GO 侧镜像，不信客户端传来的 id / ok。
 */
export function parseGoReceiptPayload(
  raw: unknown,
  opts: {
    expectedGoUserId: string;
    expectedErpUserId: string;
    currentVersion: number;
    now: Date;
  },
): GoReceipt {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const root = obj(first);
  if (!root) throw new GoReceiptError("receipt_unavailable", "GO 回执不可用（payload）", 503);

  if (root["authenticated"] !== true) {
    throw new GoReceiptError("invalid_go_token", "GO 访问令牌无效或已过期", 401);
  }
  const goUserId = str(root["user_id"]);
  if (!goUserId || goUserId !== opts.expectedGoUserId) {
    throw new GoReceiptError("go_identity_mismatch", "GO 身份与访问令牌不一致", 403);
  }
  const erpUserId = str(root["erp_user_id"]);
  if (!erpUserId || !UUID_RE.test(erpUserId) || erpUserId !== opts.expectedErpUserId) {
    throw new GoReceiptError("erp_identity_mismatch", "回执中的 ERP 账号与本人不一致", 403);
  }

  const versionRaw = root["scope_version"];
  if (typeof versionRaw !== "number" || !Number.isSafeInteger(versionRaw)) {
    throw new GoReceiptError("receipt_version_invalid", "回执版本号无效", 400);
  }
  if (versionRaw !== opts.currentVersion) {
    throw new GoReceiptError(
      "receipt_version_stale",
      "回执版本与 ERP 当前授权版本不一致，请重新拉取",
      409,
    );
  }

  const linkStatus = str(root["link_status"]);
  if (!linkStatus) throw new GoReceiptError("receipt_status_invalid", "回执状态缺失", 400);
  if (linkStatus !== "applied" && linkStatus !== "revoked") {
    throw new GoReceiptError("receipt_not_applied", `GO 尚未应用该授权（${linkStatus}）`, 409);
  }

  const syncedAt = str(root["scope_synced_at"]);
  const ts = syncedAt ? Date.parse(syncedAt) : Number.NaN;
  if (!syncedAt || Number.isNaN(ts)) {
    throw new GoReceiptError("receipt_timestamp_invalid", "回执时间无效", 400);
  }
  const age = opts.now.getTime() - ts;
  if (age > RECEIPT_MAX_AGE_MS || age < -RECEIPT_MAX_SKEW_MS) {
    throw new GoReceiptError("receipt_expired", "回执已过期（超过 60 秒），请重试", 409);
  }

  return {
    goUserId,
    erpUserId,
    scopeVersion: versionRaw,
    linkStatus,
    syncedAt,
  };
}
