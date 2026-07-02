import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import {
  ensureAccessToken,
  callYouzanApiVerbose,
} from "./youzan.functions";
import { getYouzanOutboundStatus } from "./youzan-http";
import {
  YOUZAN_API_REGISTRY,
  classifyError,
  type YzApiSpec,
  type YzProbeStatus,
} from "./youzan-api-registry";

type ShopRow = {
  id: string;
  kdt_id: number;
  shop_name: string;
  role: "hq" | "branch";
  parent_kdt_id: number | null;
  status: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
};

export type YzHealthResult = {
  api_key: string;
  shop_id: string;
  status: YzProbeStatus;
  message: string | null;
  gw_code: number | null;
  latency_ms: number | null;
  trace_id: string | null;
  preview: string | null;
};

export type YzHealthReport = {
  ran_at: string;
  outbound: ReturnType<typeof getYouzanOutboundStatus>;
  shops: Array<Pick<ShopRow, "id" | "shop_name" | "kdt_id" | "role" | "status">>;
  registry: YzApiSpec[];
  results: YzHealthResult[];
  last_stock_push: Record<
    string,
    { shop_id: string; last_pushed_at: string | null; error: string | null }[]
  >;
};

async function probeOne(
  spec: YzApiSpec,
  shop: ShopRow,
  tokenCache: Map<string, string | Error>,
): Promise<YzHealthResult> {
  const base = {
    api_key: spec.key,
    shop_id: shop.id,
    message: null as string | null,
    gw_code: null as number | null,
    latency_ms: null as number | null,
    trace_id: null as string | null,
    preview: null as string | null,
  };

  // scope 过滤
  if (spec.scope !== "both" && spec.scope !== shop.role) {
    return { ...base, status: "skip_scope" };
  }

  // token 探测特殊路径
  if (spec.key === "auth.token") {
    const started = Date.now();
    try {
      const t = await ensureAccessToken(shop);
      tokenCache.set(shop.id, t);
      return { ...base, status: "ok", latency_ms: Date.now() - started };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      tokenCache.set(shop.id, e instanceof Error ? e : new Error(msg));
      return {
        ...base,
        status: classifyError(msg),
        message: msg,
        latency_ms: Date.now() - started,
      };
    }
  }

  // 写入类跳过
  if (!spec.probe) {
    return { ...base, status: "skip_write" };
  }

  // 复用/换 token
  let token = tokenCache.get(shop.id);
  if (!token) {
    try {
      const t = await ensureAccessToken(shop);
      tokenCache.set(shop.id, t);
      token = t;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      tokenCache.set(shop.id, e instanceof Error ? e : new Error(msg));
      token = e instanceof Error ? e : new Error(msg);
    }
  }
  if (token instanceof Error) {
    return { ...base, status: "token_fail", message: token.message };
  }

  const started = Date.now();
  try {
    const r = await callYouzanApiVerbose({
      accessToken: token,
      method: spec.method,
      version: spec.version,
      params: spec.probe.params,
      timeoutMs: 8_000,
    });
    return {
      ...base,
      status: "ok",
      latency_ms: Date.now() - started,
      trace_id: r.trace_id,
      preview: r.preview,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = classifyError(msg);
    const gw = msg.match(/gw\s*(\d{3,5})|\[(\d{3,5})\]/i);
    return {
      ...base,
      status,
      message: msg,
      gw_code: gw ? Number(gw[1] ?? gw[2]) : null,
      latency_ms: Date.now() - started,
    };
  }
}

export const runYouzanApiHealthCheck = createServerFn({ method: "POST" }).handler(
  async (): Promise<YzHealthReport> => {
    const outbound = getYouzanOutboundStatus();

    const { data: shopsRaw, error } = await supabase
      .from("youzan_shops")
      .select("*")
      .order("role", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    const shops = (shopsRaw ?? []) as ShopRow[];

    const tokenCache = new Map<string, string | Error>();
    const results: YzHealthResult[] = [];

    // 先跑 token（顺序，别并发把 token 表打炸），再并行跑读接口
    const tokenSpec = YOUZAN_API_REGISTRY.find((s) => s.key === "auth.token")!;
    for (const shop of shops) {
      results.push(await probeOne(tokenSpec, shop, tokenCache));
    }
    const readSpecs = YOUZAN_API_REGISTRY.filter((s) => s.key !== "auth.token");
    const jobs: Array<Promise<YzHealthResult>> = [];
    for (const spec of readSpecs) {
      for (const shop of shops) {
        jobs.push(probeOne(spec, shop, tokenCache));
      }
    }
    // 并行但限速：8 条一组
    const chunkSize = 8;
    for (let i = 0; i < jobs.length; i += chunkSize) {
      const part = await Promise.all(jobs.slice(i, i + chunkSize));
      results.push(...part);
    }

    // 拉最近一次库存推送时间（写入类接口的辅助健康指标）
    const { data: links } = await supabase
      .from("sku_youzan_links")
      .select("shop_id, last_pushed_at, last_error, status");
    const byShop = new Map<
      string,
      { last: string | null; err: string | null }
    >();
    for (const l of (links ?? []) as Array<{
      shop_id: string;
      last_pushed_at: string | null;
      last_error: string | null;
      status: string | null;
    }>) {
      const cur = byShop.get(l.shop_id) ?? { last: null, err: null };
      if (l.last_pushed_at && (!cur.last || l.last_pushed_at > cur.last)) {
        cur.last = l.last_pushed_at;
      }
      if (l.status && l.status !== "ok" && l.last_error) cur.err = l.last_error;
      byShop.set(l.shop_id, cur);
    }
    const lastStockPush: YzHealthReport["last_stock_push"] = {
      global: shops.map((s) => ({
        shop_id: s.id,
        last_pushed_at: byShop.get(s.id)?.last ?? null,
        error: byShop.get(s.id)?.err ?? null,
      })),
    };

    return {
      ran_at: new Date().toISOString(),
      outbound,
      shops: shops.map((s) => ({
        id: s.id,
        shop_name: s.shop_name,
        kdt_id: s.kdt_id,
        role: s.role,
        status: s.status,
      })),
      registry: YOUZAN_API_REGISTRY,
      results,
      last_stock_push: lastStockPush,
    };
  },
);
