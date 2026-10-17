// 新人券包发放作业核心（纯依赖注入，便于隔离测试）。
// 规则：有赞是可核销券唯一权威；只有有赞明确返回券 id 才记成功；写入结果不明 → unknown，之后只回查、不重发；
// 未确认的接口/模板/会员映射 → blocked（真实失败原因），绝不伪造成功或往本地券表补券。
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
  | { kind: "found"; couponId: string }
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
  take(input: { groupId: string; yzOpenId: string; requestKey: string }): Promise<TakeResult>;
  queryHeld(input: { groupId: string; yzOpenId: string; requestKey: string }): Promise<QueryResult>;
};

export async function processNewcomerSlot(c: NewcomerClaim, deps: NewcomerDeps): Promise<string> {
  const finish = (o: Outcome, id: string | null, err: string | null) => deps.finish(c.slot_id, c.claim_token, o, id, err);
  if (!deps.customerAllowed(c.customer_id)) return finish("blocked", null, "canary_not_allowed");
  if (!c.youzan_coupon_group_id) return finish("blocked", null, "youzan_coupon_template_not_configured");
  let member: Awaited<ReturnType<NewcomerDeps["resolveMember"]>>;
  try { member = await deps.resolveMember(c.customer_id); } catch { return finish("unknown", null, "member_mapping_unavailable"); }
  if ("blocked" in member) return finish("blocked", null, member.blocked);
  const input = { groupId: c.youzan_coupon_group_id, yzOpenId: member.yzOpenId, requestKey: c.request_key };
  if (c.mode === "reconcile") {
    let q: QueryResult;
    try { q = await deps.queryHeld(input); } catch { q = { kind: "unavailable" }; }
    if (q.kind === "found") return finish("succeeded", q.couponId, null);
    if (q.kind === "not_found") return finish("not_found", null, "reconcile_not_found");
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

/** 有赞发券响应解析：只有 code 成功且带券 id 才算 ok；HTTP 5xx/429/超时 → unknown（可能已发出）。 */
export function parseTakeResponse(status: number, body: unknown): TakeResult {
  if (status >= 500 || status === 429) return { kind: "unknown", reason: `youzan_http_${status}` };
  if (status >= 400) return { kind: "rejected", reason: `youzan_http_${status}` };
  const j = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const ok = j.success !== false && (j.code === 200 || j.code === 0);
  if (!ok) return { kind: "rejected", reason: `youzan_code_${String(j.code ?? "unknown")}` };
  const d = (j.data && typeof j.data === "object" ? j.data : {}) as Record<string, unknown>;
  const id = d.coupon_id ?? d.id ?? d.verify_code ?? d.coupon_code;
  if (typeof id !== "string" && typeof id !== "number") return { kind: "unknown", reason: "youzan_success_without_coupon_id" };
  return { kind: "ok", couponId: String(id) };
}
