// 新人券包发放作业核心（纯依赖注入，便于隔离测试）。
// 规则：有赞是可核销券唯一权威；只有有赞明确返回券 id 才记成功；写入结果不明 → unknown，之后只回查、不重发；
// 未确认的接口/模板/会员映射 → blocked（真实失败原因），绝不伪造成功或往本地券表补券。
// 官方合同（doc4485，腾讯固定出口 8 次真实成功验证）：
//   发券 youzan.ump.coupon.send/3.0.2：activity_id + yz_open_id + requestId + verify_code；
//   真实券 ID 只在 data.voucher_identity.coupon_id（verify_code 不是券 ID）；
//   回查 youzan.ump.voucher.query/3.0.0：data 数组翻页到 total，按 yz_open_id+activity_id+verify_code 精准匹配。
import { createHash } from "node:crypto";

export type NewcomerClaim = {
  slot_id: string; claim_token: string; mode: "dispatch" | "reconcile"; request_key: string;
  customer_id: string; youzan_coupon_group_id: string | null; threshold_fen: number; amount_fen: number;
  validity_days: number; attempts: number;
};
export type TakeResult =
  | { kind: "ok"; couponId: string }
  | { kind: "rejected"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "unknown"; reason: string };
export type QueryResult =
  | { kind: "found"; couponId: string; youzanStatus?: string }
  | { kind: "not_found" }
  | { kind: "unsupported"; reason: string }
  | { kind: "unavailable" };
export type Outcome = "succeeded" | "retry" | "not_found" | "rejected" | "blocked" | "unknown";

export type NewcomerDeps = {
  workerEnabled(): boolean;
  customerAllowed(customerId: string): boolean;
  claim(limit: number, leaseSeconds: number): Promise<NewcomerClaim[]>;
  finish(slotId: string, token: string, outcome: Outcome, couponId: string | null, error: string | null): Promise<string>;
  resolveMember(customerId: string): Promise<{ yzOpenId: string } | { blocked: string }>;
  take(input: { groupId: string; yzOpenId: string; requestKey: string; verifyCode: string }): Promise<TakeResult>;
  queryHeld(input: { groupId: string; yzOpenId: string; requestKey: string; verifyCode: string }): Promise<QueryResult>;
};

/** 稳定 verify_code：'ncv' + sha256(requestKey) 前 12 位 hex = 15 位小写字母数字，不以 ZAN/YZAN 开头。
 *  与 SQL public.commerce_newcomer_verify_code(text) 必须保持一致（同一向量有测试）。 */
export function deriveVerifyCode(requestKey: string): string {
  return "ncv" + createHash("sha256").update(requestKey, "utf8").digest("hex").slice(0, 12);
}

export async function processNewcomerSlot(c: NewcomerClaim, deps: NewcomerDeps): Promise<string> {
  const finish = (o: Outcome, id: string | null, err: string | null) => deps.finish(c.slot_id, c.claim_token, o, id, err);
  if (!deps.customerAllowed(c.customer_id)) return finish("blocked", null, "canary_not_allowed");
  if (!c.youzan_coupon_group_id) return finish("blocked", null, "youzan_coupon_template_not_configured");
  let member: Awaited<ReturnType<NewcomerDeps["resolveMember"]>>;
  try { member = await deps.resolveMember(c.customer_id); } catch { return finish("unknown", null, "member_mapping_unavailable"); }
  if ("blocked" in member) {
    // 可信映射缺失/暂不可用：短暂有界重试，等待 member-sync 补上；冲突绝不合并，保持 blocked。
    const wait = member.blocked === "trusted_member_mapping_missing" || member.blocked === "trusted_member_mapping_unavailable";
    return finish(wait ? "retry" : "blocked", null, member.blocked);
  }
  const input = {
    groupId: c.youzan_coupon_group_id, yzOpenId: member.yzOpenId,
    requestKey: c.request_key, verifyCode: deriveVerifyCode(c.request_key),
  };
  if (c.mode === "reconcile") {
    let q: QueryResult;
    try { q = await deps.queryHeld(input); } catch { q = { kind: "unavailable" }; }
    if (q.kind === "found") return finish("succeeded", q.couponId, null);
    // 回查不到也绝不能回到 dispatch 重发：保持 unknown，资金不明留 attention 可观察。
    if (q.kind === "not_found") return finish("unknown", null, "reconcile_not_found");
    return finish("unknown", null, q.kind === "unsupported" ? q.reason : "reconcile_unavailable");
  }
  let r: TakeResult;
  try { r = await deps.take(input); } catch { r = { kind: "unknown", reason: "take_exception" }; }
  if (r.kind === "ok") return finish("succeeded", r.couponId, null);
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

/** 有赞发券响应解析：只有 code 成功且 data.voucher_identity.coupon_id 存在才算 ok；
 *  顶层 id/verify_code 一律不当券 ID；HTTP 5xx/429 → unknown（可能已发出）。 */
export function parseTakeResponse(status: number, body: unknown): TakeResult {
  if (status >= 500 || status === 429) return { kind: "unknown", reason: `youzan_http_${status}` };
  if (status >= 400) return { kind: "rejected", reason: `youzan_http_${status}` };
  const j = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const ok = j.success !== false && (j.code === 200 || j.code === 0);
  if (!ok) return { kind: "rejected", reason: `youzan_code_${String(j.code ?? "unknown")}` };
  const d = (j.data && typeof j.data === "object" ? j.data : {}) as Record<string, unknown>;
  const vi = (d.voucher_identity && typeof d.voucher_identity === "object" ? d.voucher_identity : {}) as Record<string, unknown>;
  const id = vi.coupon_id;
  if (typeof id !== "string" && typeof id !== "number") return { kind: "unknown", reason: "youzan_success_without_coupon_id" };
  return { kind: "ok", couponId: String(id) };
}

/** voucher.query/3.0.0 单页解析：在 data 数组里按 yz_open_id + activity_id + verify_code 精准匹配；
 *  匹配不到返回 not_found（调用方负责继续翻页到 total）；传输/业务错误 → unavailable。 */
export function parseQueryResponse(
  status: number,
  body: unknown,
  match: { yzOpenId: string; activityId: string; verifyCode: string },
): QueryResult {
  if (status >= 500 || status === 429) return { kind: "unavailable" };
  if (status >= 400) return { kind: "unavailable" };
  const j = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const ok = j.success !== false && (j.code === 200 || j.code === 0);
  if (!ok) return { kind: "unavailable" };
  const d = (j.data && typeof j.data === "object" ? j.data : {}) as Record<string, unknown>;
  const list = Array.isArray(d.vouchers) ? d.vouchers : Array.isArray(d.data) ? d.data : [];
  for (const item of list as Array<Record<string, unknown>>) {
    const ui = (item.user_identity ?? {}) as Record<string, unknown>;
    const vi = (item.voucher_identity ?? {}) as Record<string, unknown>;
    if (
      String(ui.yz_open_id ?? "") === match.yzOpenId &&
      String(item.activity_id ?? "") === match.activityId &&
      String(item.verify_code ?? "") === match.verifyCode
    ) {
      const id = vi.coupon_id;
      if (typeof id === "string" || typeof id === "number") {
        return { kind: "found", couponId: String(id), youzanStatus: String(item.status ?? item.voucher_status ?? "unknown") };
      }
      return { kind: "unavailable" };
    }
  }
  return { kind: "not_found" };
}

// ---- 有赞持券只读同步：把真实已用/作废/冻结状态映到本地镜像；绝不写积分 projection/ledger/wallet ----

export type YouzanMirrorRow = {
  id: string; code: string; external_id: string;
  metadata: { activity_id?: unknown; yz_open_id?: unknown } | null;
};
export type MirrorSyncDeps = {
  syncEnabled(): boolean;
  listActiveMirrors(limit: number): Promise<YouzanMirrorRow[]>;
  queryHeldByVerifyCode(input: { activityId: string; yzOpenId: string; verifyCode: string }):
    Promise<{ kind: "found"; couponId: string; youzanStatus: string } | { kind: "not_found" } | { kind: "unavailable" }>;
  updateMirrorStatus(mirrorId: string, status: "used" | "expired" | "void"): Promise<void>;
};

const YOUZAN_TO_LOCAL: Record<string, "used" | "expired" | "void"> = {
  used: "used", verified: "used",
  expired: "expired",
  void: "void", invalid: "void", disabled: "void", frozen: "void",
};

export async function syncYouzanCouponMirrors(deps: MirrorSyncDeps, limit = 50) {
  if (!deps.syncEnabled()) return { enabled: false, synced: 0, skipped: 0 };
  const mirrors = await deps.listActiveMirrors(Math.max(1, Math.min(limit, 200)));
  let synced = 0, skipped = 0;
  for (const m of mirrors) {
    const activityId = String(m.metadata?.activity_id ?? "");
    const yzOpenId = String(m.metadata?.yz_open_id ?? "");
    if (!activityId || !yzOpenId || !m.code) { skipped++; continue; }
    let q: Awaited<ReturnType<MirrorSyncDeps["queryHeldByVerifyCode"]>>;
    try {
      q = await deps.queryHeldByVerifyCode({ activityId, yzOpenId, verifyCode: m.code });
    } catch { q = { kind: "unavailable" }; }
    if (q.kind !== "found") { skipped++; continue; } // 查不到/不可用：不动镜像，下轮再查
    const local = YOUZAN_TO_LOCAL[q.youzanStatus];
    if (!local) { skipped++; continue; } // 仍 active：不重复写
    await deps.updateMirrorStatus(m.id, local);
    synced++;
  }
  return { enabled: true, synced, skipped };
}
