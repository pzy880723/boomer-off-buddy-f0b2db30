// 新人券包发放作业核心（纯依赖注入，便于隔离测试）。
// 规则：有赞是可核销券唯一权威；成功必须携带 provider 真实回执（券ID+verify_code+真实起止时间），
// 由 DB 的 commerce_newcomer_finish_success 逐字段校验（金额/门槛/活动/日期/唯一性），镜像插入失败整槽回滚；
// 写入结果不明 → unknown，之后只回查、不重发（not_found 也保持 unknown）；
// 未确认的接口/模板/会员映射 → blocked（真实失败原因），绝不伪造成功或往本地券表补券。
import { createHash } from "node:crypto";

export type NewcomerClaim = {
  slot_id: string; claim_token: string; mode: "dispatch" | "reconcile"; request_key: string;
  customer_id: string; youzan_coupon_group_id: string | null; threshold_fen: number; amount_fen: number;
  validity_days: number; attempts: number;
};
/** provider 真实回执：券 ID、核销码、真实生效/失效时间（有赞侧：北京时间当日 00:00 起、第 90 日 23:59:59 止）。 */
export type TakeReceipt = { couponId: string; verifyCode: string; validStart: string; validEnd: string };
export type TakeResult =
  | { kind: "ok"; receipt: TakeReceipt }
  | { kind: "rejected"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "unknown"; reason: string }
  /** 确定未发出请求（固定出口/HQ token 暂不可用）：可安全重试 */
  | { kind: "not_sent"; reason: string };
export type QueryResult =
  | { kind: "found"; receipt: TakeReceipt; youzanStatus?: string; valueFen?: number | null; thresholdFen?: number | null }
  | { kind: "not_found" }
  | { kind: "unsupported"; reason: string }
  | { kind: "unavailable" };
export type Outcome = "retry" | "not_found" | "rejected" | "blocked" | "unknown";

export type NewcomerDeps = {
  workerEnabled(): boolean;
  customerAllowed(customerId: string): boolean;
  claim(limit: number, leaseSeconds: number): Promise<NewcomerClaim[]>;
  /** 非成功状态收口（旧 5 参 RPC）；succeeded 一律走 finishSuccess。 */
  finish(slotId: string, token: string, outcome: Outcome, couponId: string | null, error: string | null): Promise<string>;
  /** 成功收口：携带真实回执，DB 逐字段校验并同事务写镜像；返回 succeeded / receipt_mismatch / stale。 */
  finishSuccess(slotId: string, token: string, receipt: TakeReceipt & { amountFen: number; thresholdFen: number; activityId: string }): Promise<string>;
  /** 发券前复核登记身份（DB：active / phone_key / phone identity / external_subject）；异常视为暂不可用。 */
  verifyIdentity(slotId: string, token: string): Promise<{ ok: true } | { blocked: string } | { stale: true }>;
  resolveMember(customerId: string): Promise<{ yzOpenId: string } | { blocked: string }>;
  take(input: { groupId: string; yzOpenId: string; requestKey: string; verifyCode: string }): Promise<TakeResult>;
  queryHeld(input: { groupId: string; yzOpenId: string; requestKey: string; verifyCode: string }): Promise<QueryResult>;
};

/** verify_code：6–20 位字母数字、不得以 ZAN/YZAN 开头；由 request_key 稳定派生，用于 unknown 精准回查。 */
export function deriveVerifyCode(requestKey: string): string {
  return "ncv" + createHash("sha256").update(requestKey, "utf8").digest("hex").slice(0, 12);
}

export async function processNewcomerSlot(c: NewcomerClaim, deps: NewcomerDeps): Promise<string> {
  const finish = (o: Outcome, id: string | null, err: string | null) => deps.finish(c.slot_id, c.claim_token, o, id, err);
  const rules = { amountFen: c.amount_fen, thresholdFen: c.threshold_fen, activityId: c.youzan_coupon_group_id ?? "" };
  if (!deps.customerAllowed(c.customer_id)) return finish("blocked", null, "canary_not_allowed");
  if (!c.youzan_coupon_group_id) return finish("blocked", null, "youzan_coupon_template_not_configured");
  // 会员映射解析发生在任何有赞写之前：dispatch 可安全重试；reconcile 槽结果未知，只能保持 unknown 继续回查，绝不转回 dispatch。
  const notYet = (reason: string) => finish(c.mode === "reconcile" ? "unknown" : "retry", null, reason);
  let idc: Awaited<ReturnType<NewcomerDeps["verifyIdentity"]>>;
  try { idc = await deps.verifyIdentity(c.slot_id, c.claim_token); } catch { return notYet("identity_check_unavailable"); }
  if ("stale" in idc) return "stale";
  if ("blocked" in idc) return c.mode === "reconcile" ? finish("unknown", null, idc.blocked) : finish("blocked", null, idc.blocked);
  let member: Awaited<ReturnType<NewcomerDeps["resolveMember"]>>;
  try { member = await deps.resolveMember(c.customer_id); } catch { return notYet("member_mapping_unavailable"); }
  if ("blocked" in member) {
    // 可信映射缺失/暂不可用：等待 member-sync；冲突绝不合并，保持 blocked。
    const wait = ["trusted_member_mapping_missing", "trusted_member_mapping_unavailable", "headquarters_token_unavailable"].includes(member.blocked);
    if (wait) return notYet(member.blocked);
    return finish("blocked", null, member.blocked);
  }
  const verifyCode = deriveVerifyCode(c.request_key);
  const input = { groupId: c.youzan_coupon_group_id, yzOpenId: member.yzOpenId, requestKey: c.request_key, verifyCode };
  const settleFromHolding = (q: Extract<QueryResult, { kind: "found" }>) => {
    if (q.valueFen !== c.amount_fen || q.thresholdFen !== c.threshold_fen) return finish("unknown", null, "holding_rules_mismatch");
    return deps.finishSuccess(c.slot_id, c.claim_token, { ...q.receipt, ...rules });
  };
  if (c.mode === "reconcile") {
    let q: QueryResult;
    try { q = await deps.queryHeld(input); } catch { q = { kind: "unavailable" }; }
    if (q.kind === "found") return settleFromHolding(q);
    if (q.kind === "not_found") return finish("not_found", null, "reconcile_not_found");
    return finish("unknown", null, q.kind === "unsupported" ? q.reason : "reconcile_unavailable");
  }
  let r: TakeResult;
  try { r = await deps.take(input); } catch { r = { kind: "unknown", reason: "take_exception" }; }
  if (r.kind === "ok") {
    // send 已成功：回执 verify_code 必须是我们派生的；再读持券精确核对归属/面额/门槛/真实日期，任何不符只留 unknown 回查，绝不重发
    if (r.receipt.verifyCode !== verifyCode) return finish("unknown", null, "send_verify_code_mismatch");
    let q: QueryResult;
    try { q = await deps.queryHeld(input); } catch { q = { kind: "unavailable" }; }
    if (q.kind !== "found") return finish("unknown", null, "post_send_holding_unconfirmed");
    if (q.receipt.couponId !== r.receipt.couponId) return finish("unknown", null, "post_send_coupon_id_mismatch");
    return settleFromHolding(q);
  }
  if (r.kind === "rejected") return finish("rejected", null, r.reason);
  if (r.kind === "blocked") return finish("blocked", null, r.reason);
  if (r.kind === "not_sent") return finish("retry", null, r.reason);
  return finish("unknown", null, r.reason);
}

export async function runNewcomerWorker(deps: NewcomerDeps, limit = 10) {
  if (!deps.workerEnabled()) return { enabled: false, claimed: 0, results: {} as Record<string, number> };
  // 每次只领 1 个槽、各自独立租约后立即处理，避免一批共享租约在慢 provider 下后排过期
  const results: Record<string, number> = {};
  let claimed = 0;
  for (let i = 0; i < Math.max(1, Math.min(limit, 50)); i++) {
    const batch = await deps.claim(1, 120);
    if (batch.length === 0) break;
    for (const c of batch) {
      claimed++;
      let s: string;
      try { s = await processNewcomerSlot(c, deps); } catch { s = "error"; }
      results[s] = (results[s] ?? 0) + 1;
    }
  }
  return { enabled: true, claimed, results };
}

// 真实合同（youzan.ump.voucheractivity.send/3.0.2 与 voucher.query/3.0.0 实际回执）：
// valid_start_time / valid_end_time 是毫秒时间戳，与 verify_code 同在 data（或持券项）顶层；voucher_identity 只有 coupon_id/coupon_type。
const asTimeMs = (v: unknown): string | null =>
  typeof v === "number" && Number.isFinite(v) && v > 1e12 ? new Date(v).toISOString() : null;
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
/** 从 send 的 data 或持券列表项提取真实回执；缺任一关键字段返回 null（调用方按 unknown 处理）。 */
function extractReceipt(d: Record<string, unknown>): TakeReceipt | null {
  const id = obj(d.voucher_identity).coupon_id;
  // 数值 coupon_id 必须是安全整数：超过 2^53-1 的值已被 JSON 解析四舍五入，券身份不可信 → 视为回执不完整。字符串原样保留。
  const idStr = typeof id === "number" ? (Number.isSafeInteger(id) && id > 0 ? String(id) : "") : typeof id === "string" ? id.trim() : "";
  const verify = typeof d.verify_code === "string" ? d.verify_code.trim() : "";
  const start = asTimeMs(d.valid_start_time);
  const end = asTimeMs(d.valid_end_time);
  if (!idStr || !verify || !start || !end) return null;
  return { couponId: idStr, verifyCode: verify, validStart: start, validEnd: end };
}

/** 有赞 voucheractivity.send/3.0.2 响应解析：code 成功且 data 顶层带 voucher_identity.coupon_id + verify_code + 毫秒起止才算 ok；HTTP 5xx/429/超时 → unknown。 */
export function parseTakeResponse(status: number, body: unknown): TakeResult {
  if (status >= 500 || status === 429) return { kind: "unknown", reason: `youzan_http_${status}` };
  if (status >= 400) return { kind: "rejected", reason: `youzan_http_${status}` };
  const j = obj(body);
  const ok = j.success !== false && (j.code === 200 || j.code === 0);
  if (!ok) return { kind: "rejected", reason: `youzan_code_${String(j.code ?? "unknown")}` };
  const receipt = extractReceipt(obj(j.data));
  if (!receipt) return { kind: "unknown", reason: "youzan_success_receipt_incomplete" };
  return { kind: "ok", receipt };
}

/** 有赞 voucher.query/3.0.0 响应解析：data 数组内按 yz_open_id + activity_id + verify_code 精准匹配；不得拿同活动另一槽的券补。 */
export function parseQueryResponse(
  status: number, body: unknown,
  match: { yzOpenId: string; activityId: string; verifyCode: string },
): QueryResult {
  if (status >= 500 || status === 429) return { kind: "unavailable" };
  if (status >= 400) return { kind: "unavailable" };
  const j = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const ok = j.success !== false && (j.code === 200 || j.code === 0);
  if (!ok) return { kind: "unavailable" };
  // 官方 voucher.query/3.0.0 真实响应：顶层 data 本身是数组，total 在顶层
  const list = Array.isArray(j.data) ? j.data : [];
  for (const item of list) {
    const it = obj(item);
    if (String(obj(it.user_identity).yz_open_id ?? "") !== match.yzOpenId) continue;
    if (String(it.activity_id ?? "") !== match.activityId) continue;
    if (typeof it.verify_code !== "string" || it.verify_code.trim() !== match.verifyCode) continue;
    const receipt = extractReceipt(it);
    if (!receipt) return { kind: "unavailable" };
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return { kind: "found", receipt, youzanStatus: String(it.status ?? "unknown"),
      valueFen: num(it.value), thresholdFen: num(it.threshold_amount) };
  }
  return { kind: "not_found" };
}

/** 官方 voucher.query 分页信息：顶层 total + data 数组长度。 */
export function queryPageInfo(body: unknown): { total: number; count: number } {
  const j = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return { total: Number(j.total ?? 0) || 0, count: Array.isArray(j.data) ? j.data.length : 0 };
}

export const QUERY_PAGE_SIZE = 50;
/** voucher.query/3.0.0 翻页（page_num，activity_type_group=1，status=0 全状态）到 total，精准匹配；异常一律 unavailable。 */
export async function queryHeldPagesWith(
  call: (body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>,
  match: { yzOpenId: string; activityId: string; verifyCode: string },
): Promise<QueryResult> {
  for (let page = 1; page <= 20; page++) {
    let res: { status: number; body: unknown };
    try {
      res = await call({ yz_open_id: match.yzOpenId, activity_type_group: 1, status: 0, page_num: page, page_size: QUERY_PAGE_SIZE });
    } catch { return { kind: "unavailable" }; }
    const parsed = parseQueryResponse(res.status, res.body, match);
    if (parsed.kind !== "not_found") return parsed;
    const { total, count } = queryPageInfo(res.body);
    if (count === 0 || page * QUERY_PAGE_SIZE >= total) return { kind: "not_found" };
  }
  return { kind: "unavailable" }; // 超页数上限：不下结论
}

/** 有赞持券只读同步：把真实状态（正常/冻结/已用/作废）镜像到 pos_customer_coupons；绝不触碰积分 projection/ledger/wallet。 */
export type MirrorStatus = "active" | "frozen" | "used" | "void";
export type MirrorSyncDeps = {
  syncEnabled(): boolean;
  /** Server-only customer + unique active HQ trusted mapping; metadata is never an identity source. */
  resolveMirrorMember(customerId: string): Promise<{ yzOpenId: string } | { blocked: string }>;
  /** 有界轮转：active/frozen 按 provider_status_checked_at NULLS FIRST 取前 limit 条。 */
  listMirrorsForSync(limit: number): Promise<YouzanMirrorRow[]>;
  queryHeldByVerifyCode(input: { activityId: string; yzOpenId: string; verifyCode: string }):
    Promise<{ kind: "found"; couponId: string; youzanStatus: string } | { kind: "not_found" } | { kind: "unavailable" }>;
  /** DB 核对 external_id 后应用；status=null 只刷新同步时间（保证轮转）。终态不回写。 */
  applyMirrorStatus(mirrorId: string, externalId: string, status: MirrorStatus | null): Promise<string>;
};
export type YouzanMirrorRow = {
  id: string; customer_id?: string; code: string; external_id: string; status?: string;
  metadata: { activity_id?: string; yz_open_id?: string; verify_code?: string } | null;
};

/** 有赞券状态：1 正常 / 2 冻结 / 3 已使用 / 4 作废 / 5 删除；另兼容英文；未知返回 null（不改状态）。 */
export function mapYouzanStatus(s: string): MirrorStatus | null {
  const v = String(s).toLowerCase();
  if (["1", "normal", "active"].includes(v)) return "active";
  if (["2", "frozen"].includes(v)) return "frozen";
  if (["3", "used", "verified"].includes(v)) return "used";
  if (["4", "5", "void", "deleted", "cancelled", "canceled", "invalid"].includes(v)) return "void";
  return null;
}

export async function syncYouzanCouponMirrors(deps: MirrorSyncDeps, limit = 50) {
  if (!deps.syncEnabled()) return { enabled: false, checked: 0, updated: 0 };
  const rows = await deps.listMirrorsForSync(limit);
  let updated = 0;
  for (const m of rows) {
    const meta = m.metadata ?? {};
    let next: MirrorStatus | null = null;
    if (m.customer_id && meta.activity_id && meta.verify_code) {
      try {
        const member = await deps.resolveMirrorMember(m.customer_id);
        // 0092 镜像不存 yz_open_id：只读可信映射补足；旧镜像有身份时还必须一致，冲突不查任何人。
        if ("yzOpenId" in member && member.yzOpenId && (!meta.yz_open_id || meta.yz_open_id === member.yzOpenId)) {
          const r = await deps.queryHeldByVerifyCode({ activityId: meta.activity_id, yzOpenId: member.yzOpenId, verifyCode: meta.verify_code });
          // 必须同一券 ID：同 code 误匹配到别的券绝不采用
          if (r.kind === "found" && r.couponId === m.external_id) next = mapYouzanStatus(r.youzanStatus);
        }
      } catch { next = null; }
    }
    // 无论结果都打同步时间戳，下轮轮到后面的镜像，避免前 N 条永久占位饿死后续
    try { if ((await deps.applyMirrorStatus(m.id, m.external_id, next)) === "updated") updated++; } catch { /* 下轮再试 */ }
  }
  return { enabled: true, checked: rows.length, updated };
}
