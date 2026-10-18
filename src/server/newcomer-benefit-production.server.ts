// 新人券包生产依赖。全部默认关闭：
//  NEWCOMER_BENEFIT_ENROLL_ENABLED=true      入会时登记（还需数据库版本 status=active）
//  NEWCOMER_BENEFIT_WORKER_ENABLED=true      作业真正调用有赞
//  NEWCOMER_BENEFIT_BACKFILL_ENABLED=true    每轮有界补漏存量已注册未领券者（排除已有 grant 及同手机号）
//  NEWCOMER_MIRROR_SYNC_ENABLED=true         有赞持券只读同步镜像状态（已用/作废/冻结）
//  NEWCOMER_BENEFIT_CANARY_CUSTOMER_IDS=a,b  只对这些顾客登记/发放；NEWCOMER_BENEFIT_ALL_CUSTOMERS=true 才放开
//  YOUZAN_COUPON_SEND_API / _VERSION         默认 youzan.ump.coupon.send / 3.0.2（官方 doc4485 合同）
//  YOUZAN_COUPON_QUERY_API / _VERSION        默认 youzan.ump.voucher.query / 3.0.0
// 有赞调用只经 youzanFetch 固定出口；会员映射只读腾讯可信映射库。
import { DatabaseSync } from "node:sqlite";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { youzanFetch } from "@/lib/youzan-http";
import { selectPointsHeadquarters } from "./youzan-points-query.server";
import {
  parseQueryResponse,
  parseTakeResponse,
  type MirrorSyncDeps,
  type NewcomerClaim,
  type NewcomerDeps,
  type QueryResult,
  type YouzanMirrorRow,
} from "./newcomer-benefit.server";

const env = (k: string) => process.env[k]?.trim() ?? "";
const canary = () => env("NEWCOMER_BENEFIT_CANARY_CUSTOMER_IDS").split(",").map((s) => s.trim()).filter(Boolean);
export const newcomerCustomerAllowed = (id: string) =>
  env("NEWCOMER_BENEFIT_ALL_CUSTOMERS") === "true" || canary().includes(id);
const proxyConfigured = () => /^https?:\/\//i.test(env("YOUZAN_PROXY_URL")) && !!env("YOUZAN_PROXY_TOKEN");

const SEND_API = () => env("YOUZAN_COUPON_SEND_API") || "youzan.ump.coupon.send";
const SEND_VERSION = () => env("YOUZAN_COUPON_SEND_VERSION") || "3.0.2";
const QUERY_API = () => env("YOUZAN_COUPON_QUERY_API") || "youzan.ump.voucher.query";
const QUERY_VERSION = () => env("YOUZAN_COUPON_QUERY_VERSION") || "3.0.0";

/** 入会登记：不等待发券；关闭/非灰度直接返回，不写库。 */
export async function enrollNewcomerIfEnabled(customerId: string, locationId: string | null) {
  if (env("NEWCOMER_BENEFIT_ENROLL_ENABLED") !== "true" || !newcomerCustomerAllowed(customerId)) return { status: "disabled" };
  const { data, error } = await supabaseAdmin.rpc("commerce_newcomer_enroll" as never,
    { p_customer: customerId, p_location: locationId } as never);
  if (error) return { status: "enroll_unavailable" };
  return data as unknown as { status: string };
}

/** 有界补漏存量已注册未领券者；默认关闭，每次最多 20 个。 */
export async function backfillNewcomerIfEnabled() {
  if (env("NEWCOMER_BENEFIT_BACKFILL_ENABLED") !== "true") return { enabled: false, enrolled: 0 };
  const { data, error } = await supabaseAdmin.rpc("commerce_newcomer_backfill" as never, { p_limit: 20 } as never);
  if (error) return { enabled: true, enrolled: 0, error: "backfill_unavailable" };
  return { enabled: true, enrolled: Number(data ?? 0) };
}

export async function newcomerSummary(customerId: string) {
  const { data, error } = await supabaseAdmin.rpc("commerce_newcomer_summary" as never, { p_customer: customerId } as never);
  if (error) throw new Error("newcomer_summary_unavailable");
  return data as unknown as { status: string; total_slots?: number; issued_slots?: number };
}

async function headquarters() {
  const { data, error } = await supabaseAdmin.from("youzan_shops")
    .select("kdt_id,parent_kdt_id,role,status,access_token,token_expires_at").eq("status", "active");
  if (error) throw Error("shop_lookup_failed");
  const hq = (data ?? []).find((s) => s.role === "hq");
  return hq ? selectPointsHeadquarters(data ?? [], hq.kdt_id) : null;
}

async function callYouzan(api: string, version: string, token: string, body: unknown) {
  return youzanFetch(`https://open.youzanyun.com/api/${api}/${version}?access_token=${encodeURIComponent(token)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}

/** voucher.query/3.0.0 翻页到 total，按 yz_open_id+activity_id+verify_code 精准匹配。 */
async function queryHeldPages(
  token: string, match: { yzOpenId: string; activityId: string; verifyCode: string },
): Promise<QueryResult> {
  const pageSize = 50;
  for (let page = 1; page <= 20; page++) {
    let res: Response;
    try {
      res = await callYouzan(QUERY_API(), QUERY_VERSION(), token, {
        yz_open_id: match.yzOpenId, page_no: page, page_size: pageSize });
    } catch { return { kind: "unavailable" }; }
    let body: unknown = null;
    try { body = await res.json(); } catch { return { kind: "unavailable" }; }
    const parsed = parseQueryResponse(res.status, body, match);
    if (parsed.kind === "found") return parsed;
    if (parsed.kind === "unavailable") return parsed;
    const d = (body as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
    const total = Number(d?.total ?? 0);
    const list = Array.isArray(d?.vouchers) ? d.vouchers : Array.isArray(d?.data) ? d.data : [];
    if (page * pageSize >= total || list.length === 0) return { kind: "not_found" };
  }
  return { kind: "unavailable" }; // 页数异常，宁可 unknown 也不下结论
}

export function productionNewcomerDeps(): NewcomerDeps {
  return {
    workerEnabled: () => env("NEWCOMER_BENEFIT_WORKER_ENABLED") === "true",
    customerAllowed: newcomerCustomerAllowed,
    async claim(limit, lease) {
      const { data, error } = await supabaseAdmin.rpc("commerce_newcomer_claim" as never, { p_limit: limit, p_lease_seconds: lease } as never);
      if (error) throw Error("newcomer_claim_failed");
      return (data ?? []) as unknown as NewcomerClaim[];
    },
    async finish(slotId, token, outcome, couponId, err) {
      const { data, error } = await supabaseAdmin.rpc("commerce_newcomer_finish" as never, {
        p_slot: slotId, p_token: token, p_outcome: outcome, p_coupon_id: couponId, p_error: err } as never);
      if (error) throw Error("newcomer_finish_failed");
      return String(data);
    },
    async resolveMember(customerId) {
      const head = await headquarters();
      if (!head) return { blocked: "headquarters_token_unavailable" };
      let db: DatabaseSync;
      try {
        db = new DatabaseSync(env("YOUZAN_MEMBER_LINK_DB") || "/var/lib/boomer-off/membership-youzan-links.sqlite", { readOnly: true });
      } catch { return { blocked: "trusted_member_mapping_unavailable" }; }
      try {
        const links = db.prepare("SELECT yz_id FROM member_channel_links WHERE customer_id=? AND kdt_id=?")
          .all(customerId, head.kdt_id) as Array<{ yz_id: string }>;
        if (links.length !== 1 || !links[0].yz_id) return { blocked: "trusted_member_mapping_missing" };
        const other = db.prepare("SELECT 1 FROM member_channel_links WHERE yz_id=? AND kdt_id=? AND customer_id<>? LIMIT 1")
          .get(links[0].yz_id, head.kdt_id, customerId);
        if (other) return { blocked: "trusted_member_mapping_conflict" };
        return { yzOpenId: links[0].yz_id };
      } finally { db.close(); }
    },
    async take({ groupId, yzOpenId, requestKey, verifyCode }) {
      if (!proxyConfigured()) return { kind: "blocked", reason: "fixed_proxy_not_configured" };
      const head = await headquarters();
      if (!head?.access_token) return { kind: "blocked", reason: "headquarters_token_unavailable" };
      let res: Response;
      try {
        // 官方 send/3.0.2：activity_id + yz_open_id + requestId + verify_code（camelCase requestId）
        res = await callYouzan(SEND_API(), SEND_VERSION(), head.access_token, {
          activity_id: groupId, yz_open_id: yzOpenId, requestId: requestKey, verify_code: verifyCode });
      } catch { return { kind: "unknown", reason: "take_transport_unknown" }; }
      let body: unknown = null;
      try { body = await res.json(); } catch { return { kind: "unknown", reason: "take_response_unreadable" }; }
      return parseTakeResponse(res.status, body);
    },
    async queryHeld({ groupId, yzOpenId, verifyCode }) {
      if (!proxyConfigured()) return { kind: "unsupported", reason: "fixed_proxy_not_configured" };
      const head = await headquarters();
      if (!head?.access_token) return { kind: "unsupported", reason: "headquarters_token_unavailable" };
      return queryHeldPages(head.access_token, { yzOpenId, activityId: groupId, verifyCode });
    },
  };
}

/** 有赞持券只读同步的生产依赖：只更新 pos_customer_coupons 镜像状态，绝不触碰积分。 */
export function productionMirrorSyncDeps(): MirrorSyncDeps {
  return {
    syncEnabled: () => env("NEWCOMER_MIRROR_SYNC_ENABLED") === "true",
    async listActiveMirrors(limit) {
      const { data, error } = await supabaseAdmin
        .from("pos_customer_coupons" as never)
        .select("id,code,external_id,metadata")
        .eq("external_provider", "youzan")
        .eq("status", "active")
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) throw Error("mirror_list_failed");
      return (data ?? []) as unknown as YouzanMirrorRow[];
    },
    async queryHeldByVerifyCode({ activityId, yzOpenId, verifyCode }) {
      const head = await headquarters();
      if (!head?.access_token || !proxyConfigured()) return { kind: "unavailable" as const };
      const r = await queryHeldPages(head.access_token, { yzOpenId, activityId, verifyCode });
      if (r.kind !== "found") return r;
      // 单券状态查询：复用 voucher.query 结果中的 status 字段；缺失时保守不可用。
      return { kind: "found", couponId: r.couponId, youzanStatus: r.youzanStatus ?? "unknown" };
    },
    async updateMirrorStatus(mirrorId, status) {
      const { error } = await supabaseAdmin
        .from("pos_customer_coupons" as never)
        .update({ status, updated_at: new Date().toISOString() } as never)
        .eq("id", mirrorId)
        .eq("external_provider", "youzan")
        .eq("status", "active"); // 只从 active 迁出，绝不回写 active
      if (error) throw Error("mirror_update_failed");
    },
  };
}
