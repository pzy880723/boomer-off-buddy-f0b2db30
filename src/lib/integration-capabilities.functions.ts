// ============================================================
// API 对接：能力矩阵后端
// ------------------------------------------------------------
// 提供：
//   listIntegrationCapabilities({ platform })
//   updateIntegrationCapability({ id, method, version, scope, token_scope })
//   resetIntegrationCapability({ id })            // 恢复到内置默认（youzan-api-registry.ts）
//   probeIntegrationCapability({ id, shop_id, params })
//
// 每个 capability 用 capability_key 走一段自己的 probe 逻辑（不是通用 dummy 参数）。
// ============================================================
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  callYouzanApiVerbose,
  ensureAccessToken,
  fetchSilentToken,
  getHqShop,
  runYouzanShopChainProbe,
} from "./youzan.functions";
import { YOUZAN_API_REGISTRY } from "./youzan-api-registry";

type ShopRow = {
  id: string;
  kdt_id: number;
  shop_name: string;
  role: "hq" | "branch";
  parent_kdt_id: number | null;
  status: string;
  sell_channel_id?: number | null;
  warehouse_code?: string | null;
  warehouse_name?: string | null;
  chain_probe_status?: "unknown" | "ok" | "partial" | "failed";
  chain_probe_at?: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
};

export type CapabilityRow = {
  id: string;
  platform: string;
  capability_key: string;
  capability_name: string;
  requirement: string;
  method: string;
  version: string;
  scope: string;
  token_scope: string;
  http_verb: string;
  doc_url: string | null;
  note: string | null;
  is_overridden: boolean;
  sort_order: number;
  updated_at: string;
};

export type ProbeRow = {
  id: string;
  capability_key: string;
  shop_id: string | null;
  method: string;
  version: string;
  request_params: any;
  http_status: number | null;
  gw_code: number | null;
  trace_id: string | null;
  latency_ms: number | null;
  ok: boolean;
  error: string | null;
  response_snippet: string | null;
  tested_at: string;
};

async function assertAdmin(ctx: { supabase: any; userId: string }) {
  const { data, error } = await ctx.supabase
    .rpc("has_role", { _user_id: ctx.userId, _role: "super_admin" });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("仅超级管理员可访问 API 对接");
}

// ------------------------------------------------------------
// 列表 + 最近一次 probe
// ------------------------------------------------------------
export const listIntegrationCapabilities = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { platform: string }) => d)
  .handler(async ({ data, context }) => {
    await assertAdmin(context as any);
    const supabase = (context as any).supabase;
    const { data: rows, error } = await supabase
      .from("integration_api_registry")
      .select("*")
      .eq("platform", data.platform)
      .order("sort_order", { ascending: true });
    if (error) throw new Error(error.message);

    // 最近一次 probe（按 capability_key 分组取 max tested_at）
    const capabilityKeys = (rows ?? []).map((r: CapabilityRow) => r.capability_key);
    let lastByKey: Record<string, ProbeRow> = {};
    if (capabilityKeys.length > 0) {
      const { data: probes, error: perr } = await supabase
        .from("integration_api_probes")
        .select("*")
        .eq("platform", data.platform)
        .in("capability_key", capabilityKeys)
        .order("tested_at", { ascending: false })
        .limit(200);
      if (perr) throw new Error(perr.message);
      for (const p of (probes ?? []) as ProbeRow[]) {
        if (!lastByKey[p.capability_key]) lastByKey[p.capability_key] = p;
      }
    }

    // 店铺列表（矩阵右上角 shop picker + 参数下拉）
    const { data: shops } = await supabase
      .from("youzan_shops")
      .select("id, kdt_id, shop_name, role, status, sell_channel_id, warehouse_code, warehouse_name, chain_probe_status, chain_probe_at")
      .order("role", { ascending: true })
      .order("created_at", { ascending: true });

    return {
      capabilities: (rows ?? []) as CapabilityRow[],
      last_probes: lastByKey,
      shops: (shops ?? []) as Array<Pick<ShopRow, "id" | "kdt_id" | "shop_name" | "role" | "status" | "sell_channel_id" | "warehouse_code" | "warehouse_name" | "chain_probe_status" | "chain_probe_at">>,
    };
  });

// ------------------------------------------------------------
// 编辑（method / version / scope / token_scope）
// ------------------------------------------------------------
export const updateIntegrationCapability = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: {
    id: string;
    method: string;
    version: string;
    scope?: string;
    token_scope?: string;
    note?: string;
  }) =>
    z
      .object({
        id: z.string().uuid(),
        method: z.string().min(1).max(120),
        version: z.string().min(1).max(20),
        scope: z.enum(["hq", "branch", "both"]).optional(),
        token_scope: z.enum(["hq", "branch", "both"]).optional(),
        note: z.string().max(2000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context as any);
    const supabase = (context as any).supabase;
    const payload: Record<string, any> = {
      method: data.method,
      version: data.version,
      is_overridden: true,
      updated_by: (context as any).userId,
    };
    if (data.scope) payload.scope = data.scope;
    if (data.token_scope) payload.token_scope = data.token_scope;
    if (typeof data.note === "string") payload.note = data.note;
    const { error } = await supabase
      .from("integration_api_registry")
      .update(payload)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ------------------------------------------------------------
// 恢复默认（从 youzan-api-registry.ts 找到 method 对应的内置版本）
// ------------------------------------------------------------
export const resetIntegrationCapability = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context as any);
    const supabase = (context as any).supabase;
    const { data: row, error } = await supabase
      .from("integration_api_registry")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("能力不存在");

    // 用 capability_key → 找内置默认的 method+version
    const defaults = DEFAULT_CAPABILITY_MAP[row.capability_key];
    if (!defaults) throw new Error("没有内置默认可恢复");

    const { error: upErr } = await supabase
      .from("integration_api_registry")
      .update({
        method: defaults.method,
        version: defaults.version,
        scope: defaults.scope,
        token_scope: defaults.token_scope,
        is_overridden: false,
        updated_by: (context as any).userId,
      })
      .eq("id", data.id);
    if (upErr) throw new Error(upErr.message);
    return { ok: true, defaults };
  });

/** capability_key → 内置默认 method / version / scope / token_scope（可扩展到别的平台） */
const DEFAULT_CAPABILITY_MAP: Record<
  string,
  { method: string; version: string; scope: "hq" | "branch" | "both"; token_scope: "hq" | "branch" | "both" }
> = {
  "auth.silent_token": { method: "auth/token", version: "silent", scope: "both", token_scope: "both" },
  "shop.chain.descendent.organization.list": {
    method: "youzan.shop.chain.descendent.organization.list",
    version: "1.0.1",
    scope: "hq",
    token_scope: "hq",
  },
  "retail.open.warehouse.query": {
    method: "youzan.retail.open.warehouse.query",
    version: "3.0.1",
    scope: "both",
    token_scope: "both",
  },
  "trades.sold.get": { method: "youzan.trades.sold.get", version: "4.0.4", scope: "branch", token_scope: "branch" },
  "trade.get": { method: "youzan.trade.get", version: "4.0.2", scope: "branch", token_scope: "branch" },
  "retail.open.online.spu.query": {
    method: "youzan.retail.open.online.spu.query",
    version: "3.0.0",
    scope: "branch",
    token_scope: "hq",
  },
  "item.detail.get": {
    method: "youzan.item.detail.get",
    version: "1.0.1",
    scope: "branch",
    token_scope: "branch",
  },
  "retail.open.spu.create": {
    method: "youzan.retail.open.spu.create",
    version: "3.0.0",
    scope: "hq",
    token_scope: "hq",
  },
  "retail.open.spu.update": {
    method: "youzan.retail.open.spu.update",
    version: "3.0.0",
    scope: "hq",
    token_scope: "hq",
  },
  "retail.open.spu.delete": {
    method: "youzan.retail.open.spu.delete",
    version: "3.0.0",
    scope: "hq",
    token_scope: "hq",
  },
  "item.quantity.update": {
    method: "youzan.item.quantity.update",
    version: "4.0.0",
    scope: "branch",
    token_scope: "branch",
  },
  "materials.storage.platform.img.upload": {
    method: "youzan.materials.storage.platform.img.upload",
    version: "3.0.0",
    scope: "hq",
    token_scope: "hq",
  },
};

// ============================================================
// 测试（probe）—— 按 capability_key 精准构造参数并调用
// ============================================================
export const probeIntegrationCapability = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: {
    id: string;
    shop_id?: string | null;
    params?: Record<string, any>;
  }) =>
    z
      .object({
        id: z.string().uuid(),
        shop_id: z.string().uuid().nullish(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context as any);
    const supabase = (context as any).supabase;

    const { data: cap, error: capErr } = await supabase
      .from("integration_api_registry")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (capErr) throw new Error(capErr.message);
    if (!cap) throw new Error("能力不存在");

    let shop: ShopRow | null = null;
    if (data.shop_id) {
      const { data: s, error } = await supabase
        .from("youzan_shops")
        .select("*")
        .eq("id", data.shop_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      shop = (s ?? null) as ShopRow | null;
    }

    const started = Date.now();
    const probe: {
      ok: boolean;
      error?: string;
      trace_id?: string | null;
      response_snippet?: string;
      gw_code?: number | null;
      http_status?: number | null;
      request_params?: Record<string, any>;
    } = { ok: false };

    try {
      const out = await runProbe({
        capability_key: cap.capability_key,
        method: cap.method,
        version: cap.version,
        token_scope: cap.token_scope as "hq" | "branch" | "both",
        shop,
        userParams: data.params ?? {},
        supabase,
      });
      probe.ok = true;
      probe.trace_id = out.trace_id;
      probe.response_snippet = out.preview;
      probe.request_params = out.request_params;
      probe.http_status = 200;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      probe.error = msg;
      const m = msg.match(/gw\s*(\d{3,5})|\[(\d{3,5})\]/i);
      probe.gw_code = m ? Number(m[1] ?? m[2]) : null;
      const traceM = msg.match(/trace=([^\s\]]+)/);
      probe.trace_id = traceM ? traceM[1] : null;
      probe.response_snippet = msg.slice(0, 800);
    }

    const latency = Date.now() - started;
    const { error: insErr } = await supabase.from("integration_api_probes").insert({
      platform: cap.platform,
      capability_key: cap.capability_key,
      shop_id: data.shop_id ?? null,
      method: cap.method,
      version: cap.version,
      request_params: (probe.request_params ?? data.params ?? {}) as any,
      http_status: probe.http_status ?? null,
      gw_code: probe.gw_code ?? null,
      trace_id: probe.trace_id ?? null,
      latency_ms: latency,
      ok: probe.ok,
      error: probe.error ?? null,
      response_snippet: probe.response_snippet ?? null,
      tested_by: (context as any).userId,
    });
    if (insErr) console.error("[probe insert]", insErr.message);

    return {
      ok: probe.ok,
      latency_ms: latency,
      trace_id: probe.trace_id ?? null,
      gw_code: probe.gw_code ?? null,
      error: probe.error ?? null,
      response_snippet: probe.response_snippet ?? null,
      request_params: probe.request_params ?? data.params ?? {},
    };
  });

export const probeShopChainForIntegration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { shop_id: string }) => z.object({ shop_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context as any);
    return runYouzanShopChainProbe(data.shop_id);
  });

// ------------------------------------------------------------
// runProbe —— 每个 capability_key 单独走一段真实调用
// ------------------------------------------------------------
async function runProbe(input: {
  capability_key: string;
  method: string;
  version: string;
  token_scope: "hq" | "branch" | "both";
  shop: ShopRow | null;
  userParams: Record<string, any>;
  supabase?: any;
}): Promise<{ trace_id: string | null; preview: string; request_params: Record<string, any> }> {
  const key = input.capability_key;

  // 1. token 类：单独走 fetchSilentToken，不打网关
  if (key === "auth.silent_token") {
    if (!input.shop) throw new Error("请选择要换 token 的店铺（HQ 或分店）");
    const t = await fetchSilentToken(input.shop.kdt_id);
    return {
      trace_id: null,
      preview: JSON.stringify({
        access_token: `${t.access_token.slice(0, 8)}...${t.access_token.slice(-4)}`,
        token_expires_at: t.token_expires_at,
        has_refresh_token: !!t.refresh_token,
      }),
      request_params: { kdt_id: input.shop.kdt_id, authorize_type: "silent" },
    };
  }

  // 1.5 查询总部下分店组织：始终用 HQ token；多版本重试；解析节点；命中当前分店时把 sell_channel_id 落库
  if (key === "shop.chain.descendent.organization.list") {
    return await probeShopChainOrgList(input);
  }

  // 2. 其他都要 token
  if (!input.shop) throw new Error("请选择用于测试的店铺");
  const tokenShop = pickTokenShop(input.shop, input.token_scope);
  const token = await ensureAccessToken(tokenShop);
  const params = await buildParams(key, input, tokenShop);
  if (key === "retail.open.warehouse.query") {
    const versions = [input.version, "3.0.1", "3.0.0", "1.0.1", "1.0.0"].filter((v, i, arr) => v && arr.indexOf(v) === i);
    const attempts: Array<{ version: string; ok: boolean; trace_id?: string | null; error?: string }> = [];
    for (const version of versions) {
      try {
        const r = await callYouzanApiVerbose({
          accessToken: token,
          method: input.method,
          version,
          params,
          timeoutMs: 15_000,
        });
        attempts.push({ version, ok: true, trace_id: r.trace_id });
        return {
          trace_id: r.trace_id,
          preview: JSON.stringify({ passed_version: version, attempts, response: safePreview(r.preview) }),
          request_params: { ...params, _tested_versions: versions },
        };
      } catch (e) {
        attempts.push({ version, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 400) });
      }
    }
    throw new Error(`仓库查询接口所有版本都没有通过：${JSON.stringify(attempts).slice(0, 1200)}`);
  }
  const r = await callYouzanApiVerbose({
    accessToken: token,
    method: input.method,
    version: input.version,
    params,
    timeoutMs: 15_000,
  });
  return { trace_id: r.trace_id, preview: r.preview, request_params: params };
}

function safePreview(preview: string) {
  try {
    return JSON.parse(preview);
  } catch {
    return preview;
  }
}

// -----------------------------------------------------------------
// 查询总部下分店组织：多版本回退 + 节点解析 + 命中当前分店时落库 sell_channel_id
// -----------------------------------------------------------------
type BranchNode = {
  kdt_id: number;
  shop_name: string | null;
  role: string | null;
  sell_channel_id: number | null;
  sell_channel_ids: number[];
  path: string;
};

function toPosNum(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractBranchNodes(payload: unknown): BranchNode[] {
  const out: BranchNode[] = [];
  const seen = new Set<unknown>();
  const KDT_KEYS = ["kdt_id", "kdtId", "shop_id", "shopId", "node_kdt_id", "nodeKdtId"];
  const NAME_KEYS = ["shop_name", "shopName", "name", "node_name", "nodeName", "title"];
  const ROLE_KEYS = ["role", "shop_role", "shopRole", "type", "node_type", "nodeType"];
  const CHAN_KEYS = ["sell_channel_id", "sellChannelId", "channel_id", "channelId"];
  const CHAN_ARR_KEYS = ["sell_channel_ids", "sellChannelIds", "channel_ids", "channelIds"];

  const walk = (node: unknown, path: string, depth: number) => {
    if (!node || depth > 10 || seen.has(node)) return;
    if (Array.isArray(node)) {
      seen.add(node);
      node.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    if (typeof node !== "object") return;
    seen.add(node);
    const rec = node as Record<string, unknown>;
    let kdt: number | null = null;
    for (const k of KDT_KEYS) {
      kdt = toPosNum(rec[k]);
      if (kdt) break;
    }
    if (kdt) {
      const nameKey = NAME_KEYS.find((k) => typeof rec[k] === "string" && (rec[k] as string).length > 0);
      const roleKey = ROLE_KEYS.find((k) => rec[k] != null);
      let chan: number | null = null;
      for (const k of CHAN_KEYS) {
        chan = toPosNum(rec[k]);
        if (chan) break;
      }
      const chanArr: number[] = [];
      for (const k of CHAN_ARR_KEYS) {
        const arr = rec[k];
        if (Array.isArray(arr)) {
          for (const v of arr) {
            const n = toPosNum(v);
            if (n) chanArr.push(n);
          }
        }
      }
      out.push({
        kdt_id: kdt,
        shop_name: nameKey ? String(rec[nameKey]) : null,
        role: roleKey ? String(rec[roleKey]) : null,
        sell_channel_id: chan ?? (chanArr[0] ?? null),
        sell_channel_ids: chanArr,
        path,
      });
    }
    for (const [k, v] of Object.entries(rec)) walk(v, `${path}.${k}`, depth + 1);
  };
  walk(payload, "$", 0);
  // 去重（同一个 kdt_id 保留信息最全的一条）
  const byKdt = new Map<number, BranchNode>();
  for (const n of out) {
    const prev = byKdt.get(n.kdt_id);
    if (!prev) {
      byKdt.set(n.kdt_id, n);
    } else {
      byKdt.set(n.kdt_id, {
        kdt_id: n.kdt_id,
        shop_name: prev.shop_name ?? n.shop_name,
        role: prev.role ?? n.role,
        sell_channel_id: prev.sell_channel_id ?? n.sell_channel_id,
        sell_channel_ids: Array.from(new Set([...prev.sell_channel_ids, ...n.sell_channel_ids])),
        path: prev.path,
      });
    }
  }
  return Array.from(byKdt.values());
}

// —— 严格按 8 条规则重写 ——
// 1) 永远先 1.0.1 再 1.0.0；2) 显式带 page_num/page_size；
// 3) 1.0.1 读 data.organization_list，1.0.0 直接读 data；
// 4) 按 total 分页；5) empty_ok / error / ok 严格三态；
// 6) 每次 attempt 保留 code/message/errors/trace_id/raw；
// 7) 任一版本 ok 即通过；8) 必须两版本都 empty_ok 才判 empty_confirmed。
export async function probeShopChainOrgList(input: {
  method: string;
  version: string;
  shop: ShopRow | null;
  supabase?: any;
}): Promise<{ trace_id: string | null; preview: string; request_params: Record<string, any> }> {
  const method = input.method || "youzan.shop.chain.descendent.organization.list";
  const versions: Array<"1.0.1" | "1.0.0"> = ["1.0.1", "1.0.0"];
  const PAGE_SIZE = 50;
  const MAX_PAGES = 20;

  // 强制使用总部 token
  let hq: ShopRow;
  try {
    hq = await getHqShop();
  } catch (e) {
    throw new Error(`没有找到已绑定的总部店铺：${e instanceof Error ? e.message : String(e)}`);
  }
  const hqToken = await ensureAccessToken(hq);
  const { YZ_GW_URL } = await import("./youzan.functions");

  type AttemptStatus = "ok" | "empty_ok" | "error";
  type PageRecord = {
    page_num: number;
    http_status: number;
    code: number | null;
    message: string | null;
    errors: unknown;
    trace_id: string | null;
    raw_body_snippet: string;
    parsed_count: number;
    total_reported: number | null;
  };
  type Attempt = {
    version: string;
    status: AttemptStatus;
    http_status: number | null;
    code: number | null;
    message: string | null;
    errors: unknown;
    trace_id: string | null;
    request_params: { page_num: number; page_size: number };
    raw_body_snippet: string;
    fetched: number;
    total_reported: number | null;
    pages: PageRecord[];
    nodes_preview: BranchNode[];
  };

  const attempts: Attempt[] = [];

  // —— 单次 raw call：不抛业务错误，全字段返回 ——
  async function rawCall(version: string, params: Record<string, unknown>): Promise<{
    http_status: number;
    trace_id: string | null;
    code: number | null;
    message: string | null;
    errors: unknown;
    data: unknown;
    raw_body: string;
    network_error?: string;
  }> {
    const url = `${YZ_GW_URL}/${method}/${version}?access_token=${encodeURIComponent(hqToken)}`;
    const ctl = new AbortController();
    const tmo = setTimeout(() => ctl.abort(), 20_000);
    let res: Response;
    let text = "";
    try {
      const { youzanFetch } = await import("./youzan-http");
      res = await youzanFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: ctl.signal,
      });
      text = await res.text();
    } catch (e) {
      clearTimeout(tmo);
      return {
        http_status: 0,
        trace_id: null,
        code: null,
        message: null,
        errors: null,
        data: null,
        raw_body: "",
        network_error: e instanceof Error ? e.message : String(e),
      };
    }
    clearTimeout(tmo);
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        http_status: res.status,
        trace_id: null,
        code: null,
        message: `响应不是 JSON：${text.slice(0, 200)}`,
        errors: null,
        data: null,
        raw_body: text,
      };
    }
    // 有赞可能把成败塞进 gw_err_resp / error_response / code
    const trace_id =
      json?.trace_id ??
      json?.gw_err_resp?.trace_id ??
      json?.error_response?.trace_id ??
      null;
    let code: number | null = null;
    let message: string | null = null;
    let errors: unknown = null;
    if (json?.gw_err_resp?.err_code) {
      code = Number(json.gw_err_resp.err_code);
      message = json.gw_err_resp.err_msg ?? null;
    } else if (json?.error_response) {
      code = typeof json.error_response.code === "number" ? json.error_response.code : null;
      message = json.error_response.msg ?? json.error_response.sub_msg ?? null;
      errors = json.error_response;
    } else if (typeof json?.code === "number") {
      code = json.code;
      message = json.message ?? null;
      if (Array.isArray(json.errors)) errors = json.errors;
    } else {
      code = 200;
    }
    return {
      http_status: res.status,
      trace_id,
      code,
      message,
      errors,
      data: json?.response ?? json?.data ?? null,
      raw_body: text,
    };
  }

  function parseList(version: "1.0.1" | "1.0.0", data: unknown): { list: unknown[]; total: number | null } {
    if (version === "1.0.1") {
      const d = (data ?? {}) as any;
      const list = Array.isArray(d.organization_list) ? d.organization_list : [];
      const total = typeof d.total === "number" ? d.total : null;
      return { list, total };
    }
    // 1.0.0：data 本身就是数组（或包一层）
    if (Array.isArray(data)) return { list: data, total: data.length };
    const d = (data ?? {}) as any;
    if (Array.isArray(d.organization_list)) return { list: d.organization_list, total: d.total ?? d.organization_list.length };
    if (Array.isArray(d.list)) return { list: d.list, total: d.total ?? d.list.length };
    return { list: [], total: 0 };
  }

  // —— 逐版本尝试 ——
  for (const version of versions) {
    const pages: PageRecord[] = [];
    const collected: unknown[] = [];
    let totalReported: number | null = null;
    let firstTrace: string | null = null;
    let firstErrCode: number | null = null;
    let firstErrMsg: string | null = null;
    let firstErrErrors: unknown = null;
    let firstHttp: number | null = null;
    let firstRawSnippet = "";
    let hadHardError = false;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const params = { page_num: page, page_size: PAGE_SIZE };
      const r = await rawCall(version, params);
      const snippet = r.raw_body.length > 8000 ? r.raw_body.slice(0, 8000) + " ...(truncated)" : r.raw_body;
      firstTrace = firstTrace ?? r.trace_id;
      firstHttp = firstHttp ?? r.http_status;
      if (!firstRawSnippet) firstRawSnippet = snippet;

      const isBusinessOk = r.code === 200 && !r.network_error;
      if (!isBusinessOk) {
        hadHardError = true;
        firstErrCode = firstErrCode ?? r.code;
        firstErrMsg = firstErrMsg ?? r.message ?? r.network_error ?? null;
        firstErrErrors = firstErrErrors ?? r.errors;
        pages.push({
          page_num: page,
          http_status: r.http_status,
          code: r.code,
          message: r.message,
          errors: r.errors,
          trace_id: r.trace_id,
          raw_body_snippet: snippet,
          parsed_count: 0,
          total_reported: null,
        });
        break;
      }
      const { list, total } = parseList(version, r.data);
      totalReported = total ?? totalReported;
      collected.push(...list);
      pages.push({
        page_num: page,
        http_status: r.http_status,
        code: r.code,
        message: r.message,
        errors: r.errors,
        trace_id: r.trace_id,
        raw_body_snippet: snippet,
        parsed_count: list.length,
        total_reported: total,
      });
      // 结束条件：本页空 / 已够 total / 页面小于 PAGE_SIZE
      if (list.length === 0) break;
      if (total != null && collected.length >= total) break;
      if (list.length < PAGE_SIZE) break;
    }

    const nodes = extractBranchNodes(collected);
    let status: AttemptStatus;
    if (hadHardError) status = "error";
    else if (nodes.length === 0) status = "empty_ok";
    else status = "ok";

    attempts.push({
      version,
      status,
      http_status: firstHttp,
      code: hadHardError ? firstErrCode : 200,
      message: hadHardError ? firstErrMsg : null,
      errors: hadHardError ? firstErrErrors : null,
      trace_id: firstTrace,
      request_params: { page_num: 1, page_size: PAGE_SIZE },
      raw_body_snippet: firstRawSnippet,
      fetched: collected.length,
      total_reported: totalReported,
      pages,
      nodes_preview: nodes.slice(0, 40),
    });

    if (status === "ok") {
      // —— 命中即落库并返回 ——
      const target = input.shop && input.shop.role === "branch" ? input.shop : null;
      let matched: BranchNode | null = null;
      let saved: { sell_channel_id: number | null; updated: boolean } = { sell_channel_id: null, updated: false };
      if (target) {
        matched = nodes.find((n) => n.kdt_id === Number(target.kdt_id)) ?? null;
        if (matched?.sell_channel_id && input.supabase) {
          const allIds = Array.from(
            new Set(
              [matched.sell_channel_id, ...(matched.sell_channel_ids || [])].filter(
                (v): v is number => typeof v === "number" && v > 0,
              ),
            ),
          );
          const patch: Record<string, any> = {
            sell_channel_id: matched.sell_channel_id,
            sell_channel_ids: allIds,
            chain_probe_status: "ok",
            chain_probe_at: new Date().toISOString(),
          };
          const { error: uerr } = await input.supabase
            .from("youzan_shops")
            .update(patch)
            .eq("id", target.id);
          if (!uerr) saved = { sell_channel_id: matched.sell_channel_id, updated: true };
          else console.error("[chain probe save]", uerr.message);
        }
      }


      const summary = {
        passed_version: version,
        conclusion: "ok" as const,
        conclusion_text: `已经拿到 ${nodes.length} 家分店节点${target ? (matched ? `，「${target.shop_name}」的渠道号已${saved.updated ? "自动落库" : "命中但未落库"}` : `，但当前选中的分店「${target.shop_name}」不在返回里`) : "（未选择分店）"}`,
        hq: { kdt_id: hq.kdt_id, name: hq.shop_name },
        aggregated: {
          total_reported: totalReported,
          fetched: collected.length,
          nodes,
        },
        current_branch: target
          ? {
              kdt_id: Number(target.kdt_id),
              name: target.shop_name,
              found_in_response: !!matched,
              sell_channel_id: matched?.sell_channel_id ?? null,
              sell_channel_ids: matched?.sell_channel_ids ?? [],
              saved_to_db: saved.updated,
            }
          : null,
        attempts,
      };
      return {
        trace_id: firstTrace,
        preview: JSON.stringify(summary, null, 2),
        request_params: { method, tested_versions: versions, page_num: 1, page_size: PAGE_SIZE, hq_kdt_id: hq.kdt_id },
      };
    }
    // 否则继续下一个版本
  }

  // —— 两个版本都没有 ok ——
  const allEmpty = attempts.every((a) => a.status === "empty_ok");
  const hasAuthErr = attempts.some(
    (a) =>
      a.status === "error" &&
      (a.code === 40009 ||
        a.code === 4005 ||
        (typeof a.message === "string" && /scope|授权|permission|unauthorized/i.test(a.message))),
  );

  let conclusion: "empty_confirmed" | "business_error" | "auth_error";
  let conclusion_text: string;
  if (allEmpty) {
    conclusion = "empty_confirmed";
    conclusion_text = "两个版本（1.0.1 / 1.0.0）都明确返回空数组：总部下确实没有可查询分店，需要在有赞后台把分店挂到总部组织树下。";
  } else if (hasAuthErr) {
    conclusion = "auth_error";
    conclusion_text = "总部授权 scope 不够（缺少连锁-组织架构相关 scope），需要重新授权总部店铺。";
  } else {
    conclusion = "business_error";
    const firstErr = attempts.find((a) => a.status === "error");
    conclusion_text = `接口业务报错：[${firstErr?.code ?? "?"}] ${firstErr?.message ?? "无 message"}（trace=${firstErr?.trace_id ?? "无"}）。见 attempts 里的完整 code / message / errors / raw_body。`;
  }

  const summary = {
    passed_version: null,
    conclusion,
    conclusion_text,
    hq: { kdt_id: hq.kdt_id, name: hq.shop_name },
    aggregated: null,
    current_branch: input.shop && input.shop.role === "branch"
      ? { kdt_id: Number(input.shop.kdt_id), name: input.shop.shop_name, found_in_response: false, sell_channel_id: null, saved_to_db: false }
      : null,
    attempts,
  };

  // 只有明确"两个版本都业务成功但空数组"才当作"非错误"，其他一律抛出让上层显示红色失败
  if (conclusion === "empty_confirmed") {
    return {
      trace_id: attempts[0]?.trace_id ?? null,
      preview: JSON.stringify(summary, null, 2),
      request_params: { method, tested_versions: versions, page_num: 1, page_size: PAGE_SIZE, hq_kdt_id: hq.kdt_id },
    };
  }
  // 抛错时，把完整 summary 塞进 error message，前端已有的 response_snippet 面板会展开显示
  const err: Error & { probe_summary?: any } = new Error(conclusion_text);
  err.probe_summary = summary;
  // 也把 summary JSON 塞在 message 里作为兜底
  err.message = `${conclusion_text}\n\n---SUMMARY---\n${JSON.stringify(summary, null, 2)}`;
  throw err;
}


function pickTokenShop(chosen: ShopRow, tokenScope: "hq" | "branch" | "both"): ShopRow {
  if (tokenScope === "both") return chosen;
  if (tokenScope === chosen.role) return chosen;
  throw new Error(
    `此能力需要用 ${tokenScope === "hq" ? "总部" : "分店"} token；你选的是 ${chosen.role === "hq" ? "总部" : "分店"}「${chosen.shop_name}」。请重新选择店铺。`,
  );
}

async function buildParams(
  key: string,
  input: { userParams: Record<string, any>; shop: ShopRow | null },
  tokenShop: ShopRow,
): Promise<Record<string, any>> {
  const u = input.userParams ?? {};
  const nowSec = Math.floor(Date.now() / 1000);
  const stamp = new Date(Date.now() + 8 * 3600 * 1000)
    .toISOString()
    .slice(0, 16)
    .replace(/[-:T]/g, "");

  switch (key) {
    case "shop.chain.descendent.organization.list":
      return {};

    case "retail.open.warehouse.query":
      return {
        page_no: Number(u.page_no ?? 1),
        page_size: Number(u.page_size ?? 20),
      };

    case "trades.sold.get": {
      const hours = Number(u.hours ?? 24);
      const end = new Date();
      const start = new Date(end.getTime() - hours * 3600 * 1000);
      const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
      return {
        page_no: 1,
        page_size: Number(u.page_size ?? 5),
        start_created: fmt(start),
        end_created: fmt(end),
      };
    }

    case "trade.get":
      if (!u.tid) throw new Error("请填写要查询的 tid");
      return { tid: String(u.tid) };

    case "retail.open.online.spu.query": {
      // token 是 HQ 的；kdt_id 走"要看谁的门店"——直接用当前选的店
      if (input.shop?.role !== "branch") {
        throw new Error("需要在【分店】上测试（用 HQ token + 分店 kdt_id）");
      }
      return {
        kdt_id: Number(input.shop.kdt_id),
        page_no: 1,
        page_size: Number(u.page_size ?? 5),
      };
    }

    case "item.detail.get":
      if (!u.item_id) throw new Error("请填写要查询的分店 item_id");
      return {
        node_kdt_id: Number(tokenShop.kdt_id),
        item_id: Number(u.item_id),
      };

    case "retail.open.spu.create": {
      // 用一个可自动删除的探针 SPU
      const spuCode =
        typeof u.spu_code === "string" && u.spu_code.length > 0
          ? u.spu_code
          : `probe-${stamp}-${Math.floor(Math.random() * 900 + 100)}`;
      const categoryId = Number(u.category_id ?? 0);
      if (!categoryId) throw new Error("请填写 category_id（有赞零售类目 ID）");
      return {
        name: String(u.name ?? `[探针]测试商品 ${stamp}`),
        spu_code: spuCode,
        unit: String(u.unit ?? "件"),
        retail_price: String(u.retail_price ?? "0.01"),
        category_id: categoryId,
        offline_create: true,
        is_up_offline: true,
        _probe_hint:
          "测试用 spu，建完请用「删除总部 SPU」传相同 spu_code 手工清理。",
      };
    }

    case "retail.open.spu.update": {
      if (!u.spu_id) throw new Error("请填写要更新的 HQ spu_id");
      const sellChannelId = Number(u.sell_channel_id ?? 0);
      if (!sellChannelId) throw new Error("请填写目标 sell_channel_id");
      return {
        spu_id: Number(u.spu_id),
        sell_channel_setting_request: {
          is_partial: 1,
          sell_channel_ids: [sellChannelId],
        },
      };
    }

    case "retail.open.spu.delete": {
      const raw = String(u.spu_codes ?? "").trim();
      if (!raw) throw new Error("请填写要删除的 spu_codes（可逗号分隔多个）");
      const codes = raw.split(/[,，\s]+/).filter(Boolean);
      return { spu_codes: codes };
    }

    case "item.quantity.update": {
      if (input.shop?.role !== "branch") throw new Error("库存覆盖必须选分店");
      if (!u.item_id) throw new Error("请填写分店 item_id");
      if (!u.sku_id) throw new Error("请填写分店 sku_id（无 SKU 商品填 item_id 同值）");
      if (u.stock_num === undefined || u.stock_num === "")
        throw new Error("请填写要设置的库存数量（会覆盖当前值）");
      return {
        kdt_id: Number(tokenShop.kdt_id),
        item_id: Number(u.item_id),
        sku_id: Number(u.sku_id),
        channel: 1,
        stock_num_str: String(u.stock_num),
      };
    }

    case "materials.storage.platform.img.upload": {
      // 有赞素材图上传：支持传 image_url（就地转 base64）或直接 image=base64
      const src = String(u.image_url ?? "");
      if (!src) throw new Error("请填写测试图片 URL（http/https）");
      const res = await fetch(src);
      if (!res.ok) throw new Error(`拉取测试图失败：HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      // base64 编码（Cloudflare Worker 支持 btoa/binary）
      let bin = "";
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      const b64 = btoa(bin);
      return { image: b64, _probe_note: `size=${buf.length}`, _ts: nowSec };
    }

    default:
      throw new Error(`未知 capability_key: ${key}`);
  }
}
