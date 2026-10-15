// 生产依赖：只读。映射来自腾讯可信 membership-youzan-links（只读 sqlite）；有赞经 youzanFetch 固定出口。
// 运行时没有该映射库（例如 Lovable 预览）时 → member_link_unavailable，绝不改为按手机号匹配。
import { createPointsProjection, type MemberResolution, type ProjectionRow, type ProjectionStore } from "./youzan-points-projection.server";
import { selectPointsHeadquarters } from "./youzan-points-query.server";

type Shop = { kdt_id: number; parent_kdt_id?: number | null; role: string; status: string; access_token?: string | null; token_expires_at?: string | null };

async function admin() {
  return (await import("@/integrations/supabase/client.server")).supabaseAdmin;
}
async function activeShops(): Promise<Shop[]> {
  const { data, error } = await (await admin()).from("youzan_shops")
    .select("kdt_id,parent_kdt_id,role,status,access_token,token_expires_at").eq("status", "active");
  if (error) throw Error("youzan_shop_lookup_failed");
  return (data ?? []) as Shop[];
}

export async function resolveTrustedYouzanMember(customerId: string): Promise<MemberResolution> {
  const shops = await activeShops();
  const heads = shops.filter(s => s.role === "hq");
  if (heads.length !== 1) return { kind: "unavailable" };
  const hq = Number(heads[0].kdt_id);
  const chain = shops.filter(s => Number(s.kdt_id) === hq || Number(s.parent_kdt_id) === hq).map(s => Number(s.kdt_id));
  let mod: typeof import("node:sqlite");
  try { mod = await import("node:sqlite"); } catch { return { kind: "unavailable" }; }
  let db: InstanceType<typeof mod.DatabaseSync>;
  try {
    db = new mod.DatabaseSync(process.env.YOUZAN_MEMBER_LINK_DB || "/var/lib/boomer-off/membership-youzan-links.sqlite", { readOnly: true });
  } catch { return { kind: "unavailable" }; }
  try {
    const marks = chain.map(() => "?").join(",");
    const mine = db.prepare(`SELECT customer_id,kdt_id,yz_id FROM member_channel_links WHERE customer_id=? AND kdt_id IN (${marks})`)
      .all(customerId, ...chain) as Array<{ yz_id: string }>;
    if (!mine.length) return { kind: "missing" };
    const ids = new Set(mine.map(l => l.yz_id));
    if (ids.size !== 1 || !mine[0].yz_id) return { kind: "conflict" };
    const yzOpenId = mine[0].yz_id;
    const others = db.prepare(`SELECT 1 FROM member_channel_links WHERE yz_id=? AND customer_id<>? AND kdt_id IN (${marks}) LIMIT 1`)
      .get(yzOpenId, customerId, ...chain);
    if (others) return { kind: "conflict" };
    return { kind: "found", customerId, kdtId: hq, yzOpenId };
  } catch {
    return { kind: "unavailable" };
  } finally {
    db.close();
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

export const productionProjectionStore: ProjectionStore = {
  async read(customerId) {
    const { data, error } = await (await admin()).from("youzan_points_projection")
      .select("customer_id,kdt_id,yz_open_id,balance,points_account_version,balance_synced_at,balance_failed_at,balance_failure,log_synced_at,log_failed_at,log_failure")
      .eq("customer_id", customerId).maybeSingle();
    if (error) throw Error("points_projection_read_failed");
    return data ? ({ ...data, points_account_version: data.points_account_version == null ? null : String(data.points_account_version) } as unknown as ProjectionRow) : null;
  },
  async recordBalance(a) {
    const { data, error } = await (await admin()).rpc("youzan_points_projection_record_balance", {
      p_customer_id: a.customerId, p_kdt_id: a.kdtId, p_yz_open_id: a.yzOpenId, p_point: a.point, p_version: a.version, p_started_at: iso(a.startedAt),
    });
    if (error) throw Error("points_projection_write_failed");
    return (data as { result: never }).result;
  },
  async recordFailure(a) {
    const { error } = await (await admin()).rpc("youzan_points_projection_record_failure", {
      p_customer_id: a.customerId, p_kind: a.kind, p_reason: a.reason, p_attempted_at: iso(a.attemptedAt),
    });
    if (error) throw Error("points_projection_write_failed");
  },
  async recordLogs(a) {
    const { data, error } = await (await admin()).rpc("youzan_points_projection_record_logs", {
      p_customer_id: a.customerId, p_kdt_id: a.kdtId, p_yz_open_id: a.yzOpenId, p_entries: a.entries as never,
      p_window_start: iso(a.windowStart), p_started_at: iso(a.startedAt),
    });
    if (error) throw Error("points_projection_write_failed");
    return data as { result: string; inserted: number };
  },
  async listLogs(customerId, limit, before) {
    let q = (await admin()).from("youzan_points_log_entries")
      .select("id,amount,balance_after,description,occurred_at,expires_at")
      .eq("customer_id", customerId)
      .order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(limit);
    if (before) q = q.or(`occurred_at.lt.${before.occurredAt},and(occurred_at.eq.${before.occurredAt},id.lt.${before.id})`);
    const { data, error } = await q;
    if (error) throw Error("points_log_read_failed");
    return (data ?? []).map(r => ({ ...r, amount: Number(r.amount), balance_after: r.balance_after == null ? null : Number(r.balance_after) }));
  },
};

export async function productionPointsProjection() {
  const { productionPointsQuery } = await import("./youzan-points-query.server");
  const { createYouzanPointsLogQuery } = await import("./youzan-points-log-query.server");
  const { youzanFetch } = await import("@/lib/youzan-http");
  const pointsQuery = await productionPointsQuery();
  const proxyConfigured = () => /^https?:\/\//i.test(process.env.YOUZAN_PROXY_URL?.trim() ?? "");
  const logQuery = createYouzanPointsLogQuery({
    proxyConfigured,
    fetchImpl: (u, i) => youzanFetch(u, i),
    async getAccessToken(kdtId) { return selectPointsHeadquarters(await activeShops(), kdtId)?.access_token ?? null; },
  });
  return createPointsProjection(productionProjectionStore, {
    resolveMember: resolveTrustedYouzanMember,
    async queryBalance(m) {
      const r = await pointsQuery({ kdtId: m.kdtId, yzOpenId: m.yzOpenId, assetKind: "points", assetKey: "" });
      if (r.kind === "ok") return { kind: "ok", point: Number(r.observed.point), version: String(r.observed.points_account_version) };
      if (r.kind === "blocked") return { kind: "blocked", reason: r.reason };
      return { kind: "unavailable" };
    },
    logsEnabled: () => process.env.YOUZAN_POINTS_LOG_ENABLED === "true",
    queryLogs: logQuery,
  });
}

/** 有界等待：超时则先返回已存投影（状态如实），后台请求完成后仍按版本规则落库。 */
export async function withBudget<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">(r => { t = setTimeout(() => r("timeout"), ms); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }
}
