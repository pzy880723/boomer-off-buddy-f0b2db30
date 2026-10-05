// 有赞积分只读查询适配器：youzan.crm.customer.points.get/1.0.0（支持 L 总部），
// is_query_points_account_version=true 返回 point / points_account_version。
// 只读；必须经 youzanFetch 固定出口（未配置代理直接 blocked，不直连）。
// 入参结构按用户提供的合同；未拿到腾讯侧真实 code=200 前不要注入生产。
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
        body: JSON.stringify({ yz_open_id: q.yzOpenId, is_query_points_account_version: true }),
      });
    } catch {
      return { kind: "unavailable" };
    }
    if (res.status >= 500 || res.status === 429) return { kind: "unavailable" };
    let j: Record<string, unknown>;
    try {
      j = (await res.json()) as Record<string, unknown>;
    } catch {
      return { kind: "unavailable" };
    }
    const ok = j && (j.success === true || j.code === 200);
    if (!ok) return { kind: "blocked", reason: "youzan_query_rejected" };
    const data = (j.data && typeof j.data === "object" ? j.data : {}) as Record<string, unknown>;
    const point = toInt(data.point);
    const ver = toInt(data.points_account_version);
    if (point === null || ver === null) return { kind: "blocked", reason: "points_response_incomplete" };
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
        .from("youzan_shops").select("access_token").eq("kdt_id", kdtId).eq("status", "active").maybeSingle();
      if (error) throw new Error("token lookup failed");
      return (data?.access_token as string | null) ?? null;
    },
  });
}
