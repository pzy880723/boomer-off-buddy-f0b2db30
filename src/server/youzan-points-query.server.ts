// 有赞积分只读查询适配器：youzan.crm.customer.points.get/1.0.0（支持 L 总部），
// is_query_points_account_version=true 返回 point / points_account_version。
// 只读；必须经 youzanFetch 固定出口（未配置代理直接 blocked，不直连）。
// 官方合同 SxGawlMSTiDAPkkRPM0cCtUKnky：以 user.account_type=5 查询映射后的有赞会员。
// 优惠券暂无确认的只读查询接口 → blocked asset_query_not_supported。
import type { AssetQuery, AssetQueryResult } from "./youzan-asset-observer.server";

export const POINTS_GET_API = "youzan.crm.customer.points.get";
export const POINTS_GET_VERSION = "1.0.0";

export type PointsQueryDeps = {
  getAccessToken(kdtId: number): Promise<string | null>;
  fetchImpl(url: string, init: RequestInit): Promise<Response>;
  proxyConfigured(): boolean;
  now?: () => number;
};

const isInt = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
const toInt = (v: unknown) => (isInt(v) ? (v as number) : typeof v === "string" && /^-?\d{1,15}$/.test(v) ? Number(v) : null);
const exactVersion = (v: unknown) =>
  typeof v === "string" && /^\d{1,19}$/.test(v) ? v : isInt(v) && (v as number) >= 0 ? String(v) : null;

type PointsShop = { kdt_id: number; parent_kdt_id?: number | null; role: string; status: string;
  access_token?: string | null; token_expires_at?: string | null };
export function selectPointsHeadquarters(shops: PointsShop[], kdtId: number, now = Date.now()): PointsShop | null {
  const shop = shops.find(s => s.kdt_id === kdtId && s.status === "active");
  if (!shop) return null;
  const root = shop.role === "hq" ? shop.kdt_id : shop.parent_kdt_id;
  const head = shops.find(s => s.kdt_id === root && s.role === "hq" && s.status === "active");
  return head?.access_token && Date.parse(head.token_expires_at ?? "") > now + 300000 ? head : null;
}

export function createYouzanPointsQuery(deps: PointsQueryDeps) {
  const now = deps.now ?? Date.now;
  return async (q: AssetQuery): Promise<AssetQueryResult> => {
    if (q.assetKind !== "points") return { kind: "blocked", reason: "asset_query_not_supported" };
    if (!deps.proxyConfigured()) return { kind: "blocked", reason: "youzan_proxy_not_configured" };
    const token = await deps.getAccessToken(q.kdtId);
    if (!token) return { kind: "blocked", reason: "shop_token_missing" };
    const url = `https://open.youzanyun.com/api/${POINTS_GET_API}/${POINTS_GET_VERSION}?access_token=${encodeURIComponent(token)}`;
    let res: Response;
    try {
      res = await deps.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: { account_id: q.yzOpenId, account_type: 5 }, is_do_extpoint: false, is_query_points_account_version: true }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      return { kind: "unavailable" };
    }
    if (res.status >= 500 || res.status === 429) return { kind: "unavailable" };
    if (!res.ok) return { kind: "blocked", reason: "youzan_query_rejected" };
    let j: Record<string, unknown>;
    try {
      // Node 22 exposes the original JSON primitive, before int64 precision is lost.
      j = JSON.parse(await res.text(), (key: string, value: unknown, context?: { source: string }) =>
        key === "points_account_version" && typeof value === "number" && context?.source
          ? context.source : value) as Record<string, unknown>;
    } catch {
      return { kind: "unavailable" };
    }
    const ok = j && j.success !== false && (j.code === 200 || j.code === 0);
    if (!ok) return { kind: "blocked", reason: "youzan_query_rejected" };
    const data = (j.data && typeof j.data === "object" ? j.data : {}) as Record<string, unknown>;
    const point = toInt(data.point);
    const ver = exactVersion(data.points_account_version);
    if (point === null || point < 0 || ver === null) return { kind: "blocked", reason: "points_response_incomplete" };
    return {
      kind: "ok",
      kdtId: q.kdtId,
      yzOpenId: q.yzOpenId,
      assetKey: "",
      observed: { point, points_account_version: ver },
      observedAt: now(),
    };
  };
}

/** 生产依赖：店铺 token 只在服务端读取，不记录日志。 */
export async function productionPointsQuery() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { youzanFetch } = await import("@/lib/youzan-http");
  return createYouzanPointsQuery({
    proxyConfigured: () => /^https?:\/\//i.test(process.env.YOUZAN_PROXY_URL?.trim() ?? ""),
    fetchImpl: (u, i) => youzanFetch(u, i),
    async getAccessToken(kdtId) {
      const { data, error } = await supabaseAdmin
        .from("youzan_shops").select("kdt_id,parent_kdt_id,role,status,access_token,token_expires_at").eq("status", "active");
      if (error) throw new Error("token lookup failed");
      return selectPointsHeadquarters((data ?? []) as PointsShop[], kdtId)?.access_token ?? null;
    },
  });
}
