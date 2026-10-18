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
  | { kind: "unknown"; reason: string };
export type QueryResult =
  | { kind: "found"; receipt: TakeReceipt; youzanStatus?: string }
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
  let member: Awaited<ReturnType<NewcomerDeps["resolveMember"]>>;
  try { member = await deps.resolveMember(c.customer_id); } catch { return finish("unknown", null, "member_mapping_unavailable"); }
  if ("blocked" in member) {
    // 可信映射缺失/暂不可用：短暂有界重试，等待 member-sync 补上；冲突绝不合并，保持 blocked。
    const wait = member.blocked === "trusted_member_mapping_missing" || member.blocked === "trusted_member_mapping_unavailable";
    return finish(wait ? "retry" : "blocked", null, member.blocked);
  }
  const verifyCode = deriveVerifyCode(c.request_key);
  const input = { groupId: c.youzan_coupon_group_id, yzOpenId: member.yzOpenId, requestKey: c.request_key, verifyCode };
  if (c.mode === "reconcile") {
    let q: QueryResult;
    try { q = await deps.queryHeld(input); } catch { q = { kind: "unavailable" }; }
    if (q.kind === "found") return deps.finishSuccess(c.slot_id, c.claim_token, { ...q.receipt, ...rules });
    if (q.kind === "not_found") return finish("not_found", null, "reconcile_not_found");
    return finish("unknown", null, q.kind === "unsupported" ? q.reason : "reconcile_unavailable");
  }
  let r: TakeResult;
  try { r = await deps.take(input); } catch { r = { kind: "unknown", reason: "take_exception" }; }
  if (r.kind === "ok") return deps.finishSuccess(c.slot_id, c.claim_token, { ...r.receipt, ...rules });
  if (r.kind === "rejected") return finish("rejected", null, r.reason);
  if (r.kind === "blocked") return finish("blocked", null, r.reason);
  return finish("unknown", null, r.reason);
}

export async function runNewcomerWorker(deps: NewcomerDeps, limit = 10) {
  if (!deps.workerEnabled()) return { enabled: false, claimed: 0, results: {} as Record<string, number> };
  const claims = await deps.claim(limit, 120);
  const results: Record<string, number> = {};
  for (const c of claims) {
    let s: string;
    try { s = await processNewcomerSlot(c, deps); } catch { s = "error"; }
    results[s] = (results[s] ?? 0) + 1;
  }
  return { enabled: true, claimed: claims.length, results };
}

const asTime = (v: unknown): string | null => {
  if (typeof v === "number" && v > 1e9) return new Date(v * 1000).toISOString();
  if (typeof v === "string" && v && !Number.isNaN(Date.parse(v))) return new Date(Date.parse(v)).toISOString();
  return null;
};
/** 从 voucher_identity 提取真实回执；缺任一关键字段返回 null（调用方按 unknown 处理）。 */
function extractReceipt(vi: Record<string, unknown>): TakeReceipt | null {
  const id = vi.coupon_id;
  const verify = vi.verify_code;
  const start = asTime(vi.valid_start_time ?? vi.valid_start);
  const end = asTime(vi.valid_end_time ?? vi.valid_end);
  if ((typeof id !== "string" && typeof id !== "number") || typeof verify !== "string" || !verify || !start || !end) return null;
  return { couponId: String(id), verifyCode: verify, validStart: start, validEnd: end };
}

/** 有赞 send/3.0.2 响应解析：只有 code 成功且 voucher_identity 带完整真实回执才算 ok；HTTP 5xx/429/超时 → unknown。 */
export function parseTakeResponse(status: number, body: unknown): TakeResult {
  if (status >= 500 || status === 429) return { kind: "unknown", reason: `youzan_http_${status}` };
  if (status >= 400) return { kind: "rejected", reason: `youzan_http_${status}` };
  const j = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const ok = j.success !== false && (j.code === 200 || j.code === 0);
  if (!ok) return { kind: "rejected", reason: `youzan_code_${String(j.code ?? "unknown")}` };
  const d = (j.data && typeof j.data === "object" ? j.data : {}) as Record<string, unknown>;
  const vi = (d.voucher_identity && typeof d.voucher_identity === "object" ? d.voucher_identity : {}) as Record<string, unknown>;
  const receipt = extractReceipt(vi);
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
  const d = (j.data && typeof j.data === "object" ? j.data : {}) as Record<string, unknown>;
  const list = Array.isArray(d.vouchers) ? d.vouchers : Array.isArray(d.data) ? d.data : [];
  for (const item of list) {
    const it = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const ui = (it.user_identity && typeof it.user_identity === "object" ? it.user_identity : {}) as Record<string, unknown>;
    const vi = (it.voucher_identity && typeof it.voucher_identity === "object" ? it.voucher_identity : {}) as Record<string, unknown>;
    if (String(ui.yz_open_id ?? "") !== match.yzOpenId) continue;
    if (String(it.activity_id ?? vi.activity_id ?? "") !== match.activityId) continue;
    if (String(vi.verify_code ?? it.verify_code ?? "") !== match.verifyCode) continue;
    const receipt = extractReceipt(vi);
    if (!receipt) return { kind: "unavailable" };
    return { kind: "found", receipt, youzanStatus: String(it.status ?? it.voucher_status ?? "unknown") };
  }
  return { kind: "not_found" };
}

/** 有赞持券只读同步：把真实状态（已用/作废/冻结）镜像到 pos_customer_coupons；绝不触碰积分 projection/ledger/wallet。 */
export type MirrorSyncDeps = {
  syncEnabled(): boolean;
  listActiveMirrors(limit: number): Promise<YouzanMirrorRow[]>;
  queryHeldByVerifyCode(input: { activityId: string; yzOpenId: string; verifyCode: string }):
    Promise<{ kind: "found"; couponId: string; youzanStatus: string } | { kind: "not_found" } | { kind: "unavailable" }>;
  updateMirrorStatus(mirrorId: string, status: "used" | "expired" | "void"): Promise<void>;
};
export type YouzanMirrorRow = {
  id: string; code: string; external_id: string;
  metadata: { activity_id?: string; yz_open_id?: string; verify_code?: string } | null;
};

const mapYouzanStatus = (s: string): "used" | "expired" | "void" | null => {
  const v = s.toLowerCase();
  if (["used", "verified", "2"].includes(v)) return "used";
  if (["expired", "4"].includes(v)) return "expired";
  if (["void", "cancelled", "canceled", "invalid", "frozen", "3", "5"].includes(v)) return "void";
  return null; // active/未知：不改镜像
};

export async function syncYouzanCouponMirrors(deps: MirrorSyncDeps, limit = 50) {
  if (!deps.syncEnabled()) return { enabled: false, checked: 0, updated: 0 };
  const rows = await deps.listActiveMirrors(limit);
  let updated = 0;
  for (const m of rows) {
    const meta = m.metadata ?? {};
    if (!meta.activity_id || !meta.verify_code || !meta.yz_open_id) continue; // 缺定位信息不猜
    let r: Awaited<ReturnType<MirrorSyncDeps["queryHeldByVerifyCode"]>>;
    try { r = await deps.queryHeldByVerifyCode({ activityId: meta.activity_id, yzOpenId: meta.yz_open_id, verifyCode: meta.verify_code }); }
    catch { continue; }
    if (r.kind !== "found") continue; // 查不到/不可用：保持现状，绝不下结论
    if (r.couponId !== m.external_id) continue; // 券 ID 不一致：不动
    const mapped = mapYouzanStatus(r.youzanStatus);
    if (!mapped) continue;
    await deps.updateMirrorStatus(m.id, mapped);
    updated++;
  }
  return { enabled: true, checked: rows.length, updated };
}
