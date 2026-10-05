// 有赞会员资产「只读观察」处理器。
// 收件箱通知只是重新查询的触发器；只接受覆盖完整正文的 Event-Sign 协议，
// 老协议即使人工重排也只保留为线索，绝不直接改资产。
// 记录 observed 必须同时满足：授权 active 店铺 → 可信映射（腾讯 membership-youzan-links，注入依赖）
// → 经固定出口的有赞只读查询返回、且返回的店铺/身份/券号与映射一致。
// 观察快照不是本地可花余额，不写 pos_customer_wallets / pos_customer_coupons / 积分账本。
// 收件箱仍无成功态：记录后 inbox 进 blocked observed_asset_adapter_not_connected。
// 依赖缺失一律 blocked，不做假成功。

export type ObsRow = {
  id: string;
  kdt_id: number;
  msg_type: string;
  biz_id: string | null;
  attempts: number;
  payload: unknown;
  envelope: unknown;
  claim_token?: string | null;
};

export type AssetKind = "points" | "coupon";
export type ObservationKey = { kdt_id: number; yz_open_id: string; asset_kind: AssetKind; asset_key: string };
export type ObservationRecordArgs = ObservationKey & {
  inbox_id: string;
  claim_token: string;
  customer_id: string;
  observed: Record<string, unknown>;
  observed_at: number;
  expected_row_version: number;
  query_source: string;
};
export type RecordResult = "recorded" | "older_observation" | "stale_version" | "stale_lease" | "same_version_observed" | "version_conflict" | "identity_conflict";

export interface ObservationStore {
  claim(limit: number, now: number): Promise<ObsRow[]>;
  finish(id: string, token: string, status: "retry" | "blocked" | "dead", reason: string, nextAttemptAt: number, now: number): Promise<boolean>;
  readVersion(key: ObservationKey): Promise<number>;
  /** 原子：校验 inbox claim_token/lease（fencing）+ 乐观版本 + observed_at 单调，成功则同事务把 inbox 置 blocked。 */
  record(args: ObservationRecordArgs): Promise<RecordResult>;
}

export type IdentityResolution =
  | { kind: "found"; customerId: string; yzOpenId: string }
  | { kind: "unknown" };

export type AssetQuery = { kdtId: number; yzOpenId: string; assetKind: AssetKind; assetKey: string };
export type AssetQueryResult =
  | { kind: "ok"; kdtId: number; yzOpenId: string; assetKey: string; observed: Record<string, unknown>; observedAt: number }
  | { kind: "not_found" }
  | { kind: "blocked"; reason: string }
  | { kind: "unavailable" };

export type ObservationDeps = {
  isActiveShop(kdtId: number): Promise<boolean>;
  /** 只接收 kdt_id + yz_open_id；不接收手机号，不得新建会员。未注入 → blocked。 */
  resolveIdentity?: (q: { kdt_id: number; yz_open_id: string }) => Promise<IdentityResolution>;
  /** 必须经 youzanFetch 固定出口的只读接口。未注入 → blocked。 */
  queryAsset?: (q: AssetQuery) => Promise<AssetQueryResult>;
  now?: () => number;
};

const MAX_ATTEMPTS = 8;
const PII_KEY = /mobile|phone|tel|name|address|id_card|idcard/i;
const retryDelay = (a: number) => Math.min(60_000 * 2 ** Math.max(0, a - 1), 3_600_000);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isSafeInteger(v) ? String(v) : "");
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function hints(row: ObsRow): { kind: AssetKind; key: string; openId: string } | null {
  const p = obj(row.payload);
  const e = obj(row.envelope);
  if (row.msg_type === "POINTS") return { kind: "points", key: "", openId: str(p.yz_open_id) };
  if (row.msg_type === "COUPON_CUSTOMER_PROMOTION") {
    return { kind: "coupon", key: str(e.voucher_id) || str(row.biz_id), openId: str(e.yz_open_id) };
  }
  return null;
}

function stripPii(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (PII_KEY.test(k)) continue;
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? stripPii(v as Record<string, unknown>) : v;
  }
  return out;
}

export async function processObservationInbox(
  store: ObservationStore,
  deps: ObservationDeps,
  opts: { limit?: number } = {},
) {
  const now = deps.now ?? Date.now;
  const rows = await store.claim(opts.limit ?? 20, now());
  const out = { claimed: rows.length, observed: 0, blocked: 0, retry: 0, dead: 0, stale: 0 };

  for (const row of rows) {
    const token = row.claim_token ?? "";
    const block = async (reason: string) => {
      if (await store.finish(row.id, token, "blocked", reason, now(), now())) out.blocked++;
      else out.stale++;
    };
    const retry = async (reason: string) => {
      const dead = row.attempts >= MAX_ATTEMPTS;
      if (await store.finish(row.id, token, dead ? "dead" : "retry", reason, now() + retryDelay(row.attempts), now())) {
        if (dead) out.dead++; else out.retry++;
      } else out.stale++;
    };
    try {
      if (obj(row.envelope).auth_protocol !== "event_sign") {
        await block("legacy_signature_readonly_hint"); continue;
      }
      const h = hints(row);
      if (!h) { await block("unsupported_msg_type"); continue; }
      if (!h.openId) { await block("missing_member_identity"); continue; }
      if (h.kind === "coupon" && !h.key) { await block("missing_voucher_id"); continue; }
      if (!(await deps.isActiveShop(row.kdt_id))) { await block("shop_not_authorized"); continue; }
      if (!deps.resolveIdentity) { await block("identity_resolver_not_connected"); continue; }
      const who = await deps.resolveIdentity({ kdt_id: row.kdt_id, yz_open_id: h.openId });
      if (who.kind !== "found" || !who.customerId || !who.yzOpenId) { await block("unknown_member"); continue; }
      if (!deps.queryAsset) { await block("asset_query_not_connected"); continue; }

      const key: ObservationKey = { kdt_id: row.kdt_id, yz_open_id: who.yzOpenId, asset_kind: h.kind, asset_key: h.key };
      // 乐观版本：查询前读取，写入时必须未被他人推进。
      const expected = await store.readVersion(key);
      const q = await deps.queryAsset({ kdtId: row.kdt_id, yzOpenId: who.yzOpenId, assetKind: h.kind, assetKey: h.key });
      if (q.kind === "unavailable") { await retry("asset_query_unavailable"); continue; }
      if (q.kind === "not_found") { await block("asset_not_found_on_query"); continue; }
      if (q.kind === "blocked") { await block(/^[a-z_]{1,60}$/.test(q.reason) ? q.reason : "asset_query_blocked"); continue; }
      if (q.kdtId !== row.kdt_id || q.yzOpenId !== who.yzOpenId || q.assetKey !== h.key) {
        await block("query_identity_mismatch"); continue;
      }
      if (!Number.isFinite(q.observedAt) || q.observedAt <= 0) { await block("query_time_invalid"); continue; }

      const r = await store.record({
        ...key,
        inbox_id: row.id,
        claim_token: token,
        customer_id: who.customerId,
        observed: stripPii(obj(q.observed)),
        observed_at: q.observedAt,
        expected_row_version: expected,
        query_source: "youzan_fixed_proxy_readonly",
      });
      if (r === "recorded" || r === "same_version_observed") out.observed++;
      else if (r === "older_observation" || r === "version_conflict" || r === "identity_conflict") out.blocked++;
      else if (r === "stale_version") await retry("stale_version");
      else out.stale++;
    } catch (e) {
      void e; // 固定安全代码，不复制错误内容
      await retry("transient_error");
    }
  }
  return out;
}

/** 生产存储：service_role RPC；anon/authenticated 无执行权。 */
export async function supabaseObservationStore(): Promise<ObservationStore> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await supabaseAdmin.rpc(fn as never, args as never);
    if (error) throw new Error("rpc failed");
    return data as unknown;
  };
  return {
    async claim(limit) {
      const rows = (await rpc("youzan_asset_inbox_claim", { p_limit: limit })) as ObsRow[] | null;
      return rows ?? [];
    },
    async finish(id, token, status, reason, next) {
      return (await rpc("youzan_asset_inbox_finish", {
        p_id: id, p_claim_token: token, p_status: status, p_reason: reason,
        p_next_attempt_at: new Date(next).toISOString(),
      })) === true;
    },
    async readVersion(k) {
      return Number(await rpc("youzan_asset_observation_version", {
        p_kdt_id: k.kdt_id, p_yz_open_id: k.yz_open_id, p_asset_kind: k.asset_kind, p_asset_key: k.asset_key,
      })) || 0;
    },
    async record(a) {
      const res = (await rpc("youzan_asset_observation_record", {
        p_inbox_id: a.inbox_id, p_claim_token: a.claim_token, p_kdt_id: a.kdt_id, p_yz_open_id: a.yz_open_id,
        p_asset_kind: a.asset_kind, p_asset_key: a.asset_key, p_customer_id: a.customer_id,
        p_observed: a.observed, p_observed_at: new Date(a.observed_at).toISOString(),
        p_expected_row_version: a.expected_row_version, p_query_source: a.query_source,
      })) as { result: RecordResult };
      return res.result;
    },
  };
}

/** 生产默认依赖：只有授权店铺校验；映射与查询需腾讯侧注入，未注入即 blocked。 */
export async function productionObservationDeps(inject: Pick<ObservationDeps, "resolveIdentity" | "queryAsset"> = {}): Promise<ObservationDeps> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return {
    async isActiveShop(kdtId) {
      const { data, error } = await supabaseAdmin
        .from("youzan_shops").select("id").eq("kdt_id", kdtId).eq("status", "active").maybeSingle();
      if (error) throw new Error("shop lookup failed");
      return !!data;
    },
    ...inject,
  };
}
