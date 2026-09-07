/**
 * GO ← ERP 授权刷新通道（纯逻辑，可单测，不访问数据库 / 不解析 token）。
 *
 * 铁律：
 *  - 这是「授权刷新」通道：不能因为 GO 旧 scope / 租约过期 / 休息 / 已撤销镜像而挡住刷新。
 *  - 唯一可信身份来自 GO 无参 RPC 返回的 erp_user_id；不接受客户端传入的 ERP ID。
 *  - HQ 无需门店授权：显式 HQ 角色即使 shops 为空仍是 HQ。
 *  - 员工只要缺任意一个门店映射 → 安全阻断整份 scope（不下发部分授权），
 *    payload 里 permissions/shops 一律为空，active=false，status=unconfigured。
 *  - 停用 / 撤销 → 返回可信 revoked 墓碑。
 *  - scope_version 由数据库持久快照（payload hash + 单调整数）给出。
 *  - 权限键必须是 GO 真实动作键（ERP 是唯一真源，但键名与 GO 对齐）。
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
  /** 固定 GO 项目 + 当前已核验 go_user_id 下的绑定状态（pending|approved|rejected|revoked）；无记录为 null */
  identity_status: string | null;
  /** 本人授权门店的显式 active 映射（数据库已按项目/kind/active 过滤） */
  shop_links: AuthorizationShop[];
  /** 数据库持久版本（同 payload 稳定，payload 变化才递增） */
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

/**
 * 权限模型版本：权限映射代码一改就必须 +1，
 * 数据库据此把它算进快照 payload，从而让版本单调递增（避免同 version 不同权限）。
 */
export const PERMISSION_MODEL_REV = 2;

const STAFF_PERMISSIONS = [
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
];

const MANAGER_PERMISSIONS = [
  ...STAFF_PERMISSIONS,
  "community.moderate",
  "correction.review",
  "dayoff.write",
  "history.read_all",
  "knowledge.official.write",
  "product.delete",
  "schedule.ai",
  "schedule.clear",
  "schedule.write",
  "shift.write",
  "shop.kb.category",
  "shop.kb.write",
  "shop.read",
  "staff.read",
  "staff.write",
  "user.read",
  "voucher.manage",
];

const SUPER_ADMIN_PERMISSIONS = [
  "community.moderate",
  "community.post",
  "correction.review",
  "dayoff.write",
  "history.read_all",
  "holiday.write",
  "knowledge.official.read",
  "knowledge.official.write",
  "knowledge.personal.write",
  "price.write",
  "product.create",
  "product.delete",
  "product.edit",
  "recognition.use",
  "role.manage",
  "schedule.ai",
  "schedule.clear",
  "schedule.view_self",
  "schedule.view_shop",
  "schedule.write",
  "settings.ai",
  "settings.recognition",
  "shift.write",
  "shop.kb.category",
  "shop.kb.read",
  "shop.kb.write",
  "shop.read",
  "shop.write",
  "staff.read",
  "staff.write",
  "user.create",
  "user.read",
  "user.reset_password",
  "user.suspend",
  "user.update_role",
  "voucher.manage",
  "voucher.redeem",
];

/** 总部运营：知识库 / 拍照识别 / 全局排班与门店读取，绝不冒充 super_admin */
const HQ_OPERATOR_PERMISSIONS = [
  "history.read_all",
  "knowledge.official.read",
  "knowledge.official.write",
  "knowledge.personal.write",
  "recognition.use",
  "schedule.view_self",
  "schedule.view_shop",
  "shop.kb.read",
  "shop.read",
  "staff.read",
];

const WAREHOUSE_PERMISSIONS = [
  "knowledge.official.read",
  "knowledge.personal.write",
  "recognition.use",
  "schedule.view_self",
];

/** ERP 角色 → GO 真实动作权限键 */
const ROLE_PERMISSIONS: Record<string, string[]> = {
  super_admin: SUPER_ADMIN_PERMISSIONS,
  hq_operator: HQ_OPERATOR_PERMISSIONS,
  store_manager: MANAGER_PERMISSIONS,
  store_staff: STAFF_PERMISSIONS,
  warehouse_staff: WAREHOUSE_PERMISSIONS,
};

export function permissionsForRoles(roles: string[]): string[] {
  const out = new Set<string>();
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role] ?? []) out.add(p);
  return [...out].sort();
}

export function buildAuthorizationSnapshot(facts: AuthorizationFacts): AuthorizationSnapshot {
  const base = {
    erp_user_id: facts.erp_user_id,
    scope_version: facts.version,
    updated_at: facts.generated_at,
  };
  const blocked = (status: AuthorizationStatus, reasons: string[], revoked: boolean) => ({
    ...base,
    active: false,
    revoked,
    status,
    roles: [] as string[],
    permissions: [] as string[],
    is_hq: false,
    shops: [] as AuthorizationShop[],
    reasons,
  });

  // 1) 没有真实 ERP 账号 → 一律不授予任何权限
  if (!facts.account_exists) return blocked("no_erp_account", ["erp_account_missing"], true);

  // 2) 停用 / 删除 / 显式撤销绑定 → 可信 revoked 墓碑
  const revokedReasons: string[] = [];
  if (facts.banned) revokedReasons.push("erp_account_disabled");
  if (facts.deleted) revokedReasons.push("erp_account_deleted");
  // go_identity_links.status 真实取值：pending | approved | rejected | revoked
  if (facts.identity_status === "revoked") revokedReasons.push("identity_revoked");
  if (facts.identity_status === "rejected") revokedReasons.push("identity_rejected");
  if (revokedReasons.length > 0) return blocked("revoked", revokedReasons, true);

  const roles = [...facts.roles].sort();
  if (roles.length === 0) return blocked("unconfigured", ["no_erp_role"], false);

  const isHq = roles.some((r) => HQ_ROLES.has(r));
  const permissions = permissionsForRoles(roles);

  // 3) HQ：无需门店授权，目录可为空仍是 HQ
  if (isHq) {
    const reasons = facts.shop_links.length === 0 ? ["shop_directory_empty"] : [];
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

  // 4) 员工：映射必须完整，否则安全阻断整份 scope（绝不下发部分授权）
  const byLocation = new Map(facts.shop_links.map((s) => [s.erp_location_id, s]));
  const unmapped = facts.location_ids.filter((id) => !byLocation.has(id));

  if (facts.location_ids.length === 0) {
    return blocked("unconfigured", ["no_location_permission"], false);
  }
  if (unmapped.length > 0) {
    return blocked(
      "unconfigured",
      ["shop_mapping_unconfigured", ...unmapped.map((id) => `unmapped_location:${id}`)],
      false,
    );
  }

  const shops = facts.location_ids
    .map((id) => byLocation.get(id)!)
    .sort((a, b) => a.go_shop_id.localeCompare(b.go_shop_id));

  return {
    ...base,
    active: true,
    revoked: false,
    status: "ok",
    roles,
    permissions,
    is_hq: false,
    shops,
    reasons: [],
  };
}

// ------------------------------------------------------------ 回执（ack）校验

export const RECEIPT_MAX_AGE_MS = 60_000;
/** 允许的时钟前偏（GO 时钟略快时不误杀） */
const RECEIPT_MAX_SKEW_MS = 5_000;

/** GO 真实镜像状态键（applied 是 apply 动作的结果码，不是镜像状态） */
export type GoLinkStatus = "active" | "revoked";

export type GoReceipt = {
  goUserId: string;
  erpUserId: string;
  scopeVersion: number;
  linkStatus: GoLinkStatus;
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

/** 当前 ERP 快照期望 GO 镜像成为什么状态 */
export function expectedLinkStatus(snapshot: AuthorizationSnapshot): GoLinkStatus {
  return snapshot.revoked ? "revoked" : "active";
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
    expectedLinkStatus: GoLinkStatus;
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
  if (linkStatus !== "active" && linkStatus !== "revoked") {
    throw new GoReceiptError("receipt_status_invalid", `回执镜像状态无效（${linkStatus}）`, 400);
  }
  // 同 version 但状态不符（例如 revoked 回执确认 active 授权）必须拒绝
  if (linkStatus !== opts.expectedLinkStatus) {
    throw new GoReceiptError(
      "receipt_status_mismatch",
      `GO 镜像状态（${linkStatus}）与 ERP 当前授权（${opts.expectedLinkStatus}）不一致`,
      409,
    );
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

  return { goUserId, erpUserId, scopeVersion: versionRaw, linkStatus, syncedAt };
}
