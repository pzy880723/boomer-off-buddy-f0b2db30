// 新人券包生产依赖。全部默认关闭：
//  NEWCOMER_BENEFIT_ENROLL_ENABLED=true      入会时登记（还需数据库版本 status=active）
//  NEWCOMER_BENEFIT_WORKER_ENABLED=true      作业真正调用有赞
//  NEWCOMER_BENEFIT_CANARY_CUSTOMER_IDS=a,b  只对这些顾客登记/发放；NEWCOMER_BENEFIT_ALL_CUSTOMERS=true 才放开
//  YOUZAN_COUPON_TAKE_API / _VERSION         有赞发券接口（未经真实 code=200 验证前不配置 → blocked）
//  YOUZAN_COUPON_QUERY_API / _VERSION        有赞持券查询接口（未配置 → 回查 unsupported，unknown 槽位保持不重发）
// 有赞调用只经 youzanFetch 固定出口；会员映射只读腾讯可信映射库。
import { DatabaseSync } from "node:sqlite";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { youzanFetch } from "@/lib/youzan-http";
import { selectPointsHeadquarters } from "./youzan-points-query.server";
import { parseTakeResponse, type NewcomerClaim, type NewcomerDeps } from "./newcomer-benefit.server";

const env = (k: string) => process.env[k]?.trim() ?? "";
const canary = () => env("NEWCOMER_BENEFIT_CANARY_CUSTOMER_IDS").split(",").map((s) => s.trim()).filter(Boolean);
export const newcomerCustomerAllowed = (id: string) =>
  env("NEWCOMER_BENEFIT_ALL_CUSTOMERS") === "true" || canary().includes(id);
const proxyConfigured = () => /^https?:\/\//i.test(env("YOUZAN_PROXY_URL")) && !!env("YOUZAN_PROXY_TOKEN");

/** 入会登记：不等待发券；关闭/非灰度直接返回，不写库。 */
export async function enrollNewcomerIfEnabled(customerId: string, locationId: string | null) {
  if (env("NEWCOMER_BENEFIT_ENROLL_ENABLED") !== "true" || !newcomerCustomerAllowed(customerId)) return { status: "disabled" };
  const { data, error } = await supabaseAdmin.rpc("commerce_newcomer_enroll" as never,
    { p_customer: customerId, p_location: locationId } as never);
  if (error) return { status: "enroll_unavailable" };
  return data as unknown as { status: string };
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
    async take({ groupId, yzOpenId, requestKey }) {
      const api = env("YOUZAN_COUPON_TAKE_API"), ver = env("YOUZAN_COUPON_TAKE_VERSION");
      if (!api || !ver) return { kind: "blocked", reason: "coupon_take_api_unconfirmed" };
      if (!proxyConfigured()) return { kind: "blocked", reason: "fixed_proxy_not_configured" };
      const head = await headquarters();
      if (!head?.access_token) return { kind: "blocked", reason: "headquarters_token_unavailable" };
      let res: Response;
      try {
        res = await callYouzan(api, ver, head.access_token, {
          coupon_group_id: groupId, yz_open_id: yzOpenId, request_id: requestKey });
      } catch { return { kind: "unknown", reason: "take_transport_unknown" }; }
      let body: unknown = null;
      try { body = await res.json(); } catch { return { kind: "unknown", reason: "take_response_unreadable" }; }
      return parseTakeResponse(res.status, body);
    },
    async queryHeld() {
      const api = env("YOUZAN_COUPON_QUERY_API");
      if (!api) return { kind: "unsupported", reason: "coupon_holding_query_unconfirmed" };
      // 查询接口合同未经真实验证前不解析，保持 unknown，不重发。
      return { kind: "unsupported", reason: "coupon_holding_query_contract_unverified" };
    },
  };
}
