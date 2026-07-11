import { createServerFn } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";
import { z } from "zod";
import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { yzStatusText } from "./youzan-status";
import { getYouzanOutboundStatus, youzanFetch } from "./youzan-http";

// ============================================================
// 有赞自用型应用 OAuth：grant_type=silent + kdt_id
// 文档：https://doc.youzanyun.com/detail/API/0/906
// ============================================================
const YZ_OAUTH_URL = "https://open.youzanyun.com/auth/token";
// 有赞云新网关地址：POST https://open.youzanyun.com/api/{接口名}/{版本号}?access_token=xxx
// 注意：旧的 /api/oauthentry 路径在零售连锁版接口上会被网关判定为 [gw 4005] 非法的API
const YZ_GW_URL = "https://open.youzanyun.com/api";

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

async function fetchSilentToken(kdtId: number) {
  const clientId = process.env.YOUZAN_CLIENT_ID;
  const clientSecret = process.env.YOUZAN_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("YOUZAN_CLIENT_ID / YOUZAN_CLIENT_SECRET 未配置");
  }
  // 有赞自用型应用换 token 的正确参数（官方文档 doc/7515）
  const res = await youzanFetch(YZ_OAUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      authorize_type: "silent",
      grant_id: String(kdtId),
      refresh: "false",
    }),
  });
  const text = await res.text();
  let json: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    expires?: number;
    success?: boolean;
    code?: number;
    message?: string;
    data?: {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      expires?: number;
    } | null;
    error?: string;
    error_response?: { code?: number; msg?: string };
  } = {};
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`有赞响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  const access_token = json.access_token ?? json.data?.access_token;
  const refresh_token = json.refresh_token ?? json.data?.refresh_token ?? null;
  const expires_in = json.expires_in ?? json.data?.expires_in;
  // 自用型返回 expires 是毫秒时间戳
  const expiresTs = json.expires ?? json.data?.expires;

  // 自用型成功 code=200；其它接口也可能返回 code=0
  const codeOk =
    json.code === undefined || json.code === 0 || json.code === 200;
  const isFailed =
    !res.ok || !access_token || json.success === false || !codeOk;
  if (isFailed) {
    const msg =
      json.message ||
      json.error_response?.msg ||
      json.error ||
      `HTTP ${res.status} ${text.slice(0, 200)}`;
    throw new Error(formatYouzanIpError(`有赞换 token 失败：${msg}`));
  }
  let expiresAt: string;
  if (expiresTs && expiresTs > 1_000_000_000_000) {
    expiresAt = new Date(expiresTs).toISOString();
  } else if (expires_in) {
    expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
  } else {
    expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  }
  return {
    access_token,
    refresh_token,
    token_expires_at: expiresAt,
  };
}

function formatYouzanIpError(message: string) {
  if (/gw\s*4007|IP\s*.*white|whitelist|白名单|源\s*IP\s*地址/i.test(message)) {
    const outbound = getYouzanOutboundStatus();
    if (outbound.mode === "fixed_proxy") {
      return `${message}。当前已启用固定出口代理，请确认有赞白名单配置的是固定代理出口 IP${outbound.outbound_ip ? `：${outbound.outbound_ip}` : ""}，不是历史动态 IP。`;
    }
    return `${message}。当前仍是直连动态出口，发布后也不保证 IP 固定；请配置 YOUZAN_PROXY_URL 固定出口代理后，只把代理 IP 加入有赞白名单。`;
  }
  return message;
}

export function explainYouzanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/尚未配置有赞默认商品分组|默认商品分组|默认分组/i.test(message)) {
    return "系统会自动去有赞创建「ERP自动同步」分组；刚才创建没成功。请直接点重试，系统会再自动处理。";
  }
  if (/gw\s*4005|非法的\s*API|invalid\s*api/i.test(message)) {
    return [
      "有赞没有接受这次接口调用，系统已经把有赞原始返回拿到了。",
      "如果是创建分组，系统会自动换参数再试；如果是推商品，就是有赞拒绝了当前商品接口。",
      `原始返回：${message}`,
    ].join("\n");
  }
  if (/gw\s*4007|IP\s*.*white|whitelist|白名单|源\s*IP\s*地址/i.test(message)) {
    return formatYouzanIpError(message);
  }
  if (/token|access_token|授权|authorize|auth/i.test(message)) {
    return `有赞授权失效或店铺授权不完整。请先在「设置 → 集成」里做一次有赞同步体检。原始返回：${message}`;
  }
  if (/timeout|超时|network|fetch|网络/i.test(message)) {
    return `连接有赞超时或网络不稳定，请稍后重试。原始返回：${message}`;
  }
  return message || "有赞同步失败，但没有返回具体原因。";
}

/**
 * 拿一家店的 access_token：有缓存且未过期则直接用，
 * 否则向有赞重新换并写回 youzan_shops。
 * （exported 给 youzan-sync.functions.ts 复用）
 */
export async function ensureAccessToken(shop: ShopRow): Promise<string> {
  const now = Date.now();
  const expAt = shop.token_expires_at
    ? new Date(shop.token_expires_at).getTime()
    : 0;
  // 过期前 5 分钟刷新
  if (shop.access_token && expAt - now > 5 * 60 * 1000) {
    return shop.access_token;
  }
  const t = await fetchSilentToken(shop.kdt_id);
  await supabase
    .from("youzan_shops")
    .update({
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      token_expires_at: t.token_expires_at,
    } as never)
    .eq("id", shop.id);
  return t.access_token;
}

function getYouzanSyncActions(shop: Pick<ShopRow, "role">): Array<"items" | "orders"> {
  // 总部只同步商品总账；真实销售订单属于分店。
  return shop.role === "hq" ? ["items"] : ["items", "orders"];
}

function dispatchYouzanSyncWorker(opts: {
  origin: string;
  shop_id: string;
  action: "items" | "orders";
  days?: number;
}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apikey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (apikey) headers.apikey = apikey;

  void fetch(`${opts.origin}/api/public/hooks/youzan-sync-worker`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      shop_id: opts.shop_id,
      action: opts.action,
      days: opts.days,
    }),
  }).catch((e) => {
    console.error("[youzan sync dispatch]", opts.shop_id, opts.action, e);
  });
}


async function getShopOr404(idOrKdt: { shop_id?: string; kdt_id?: number }) {
  let q = supabase.from("youzan_shops").select("*").limit(1);
  if (idOrKdt.shop_id) q = q.eq("id", idOrKdt.shop_id);
  else if (idOrKdt.kdt_id) q = q.eq("kdt_id", idOrKdt.kdt_id);
  else throw new Error("缺少 shop_id 或 kdt_id");
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("门店不存在");
  return data as ShopRow;
}

/** 通用：调用有赞 API（自用型 token 走 oauthentry 网关） */
async function callYouzanApi(opts: {
  accessToken: string;
  method: string; // e.g. youzan.shop.get
  version: string; // e.g. 3.0.0
  params?: Record<string, unknown>;
}): Promise<unknown> {
  const r = await callYouzanApiVerbose(opts);
  return r.payload;
}

/** 返回 payload + trace_id + 原始响应前 400 字，方便排查；自带 20s 超时 */
export async function callYouzanApiVerbose(opts: {
  accessToken: string;
  method: string;
  version: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<{ payload: unknown; trace_id: string | null; preview: string }> {
  const url = `${YZ_GW_URL}/${opts.method}/${opts.version}?access_token=${encodeURIComponent(opts.accessToken)}`;
  const ctl = new AbortController();
  const tmo = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000);
  let res: Response;
  try {
    res = await youzanFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts.params ?? {}),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(tmo);
    const msg = e instanceof Error && e.name === "AbortError"
      ? `请求超时 (${opts.method})`
      : `网络错误：${e instanceof Error ? e.message : String(e)}`;
    throw new Error(msg);
  }
  clearTimeout(tmo);
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`有赞响应不是 JSON：${text.slice(0, 200)}`);
  }
  const j = json as {
    error_response?: { code?: number; msg?: string; sub_msg?: string };
    response?: unknown;
    success?: boolean;
    code?: number;
    message?: string;
    data?: unknown;
    trace_id?: string;
    gw_err_resp?: { trace_id?: string; err_msg?: string; err_code?: number };
  };
  const trace = j.trace_id ?? j.gw_err_resp?.trace_id ?? null;
  const preview = text.length > 400 ? text.slice(0, 400) + "..." : text;
  if (j.gw_err_resp?.err_code) {
    const g = j.gw_err_resp;
    throw new Error(formatYouzanIpError(`[gw ${g.err_code}] ${g.err_msg ?? ""}${trace ? ` trace=${trace}` : ""}`.trim()));
  }
  if (j.error_response) {
    const e = j.error_response;
    throw new Error(formatYouzanIpError(`[${e.code}] ${e.msg ?? ""} ${e.sub_msg ?? ""}${trace ? ` trace=${trace}` : ""}`.trim()));
  }
  if (j.success === false || (typeof j.code === "number" && j.code !== 0 && j.code !== 200)) {
    throw new Error(formatYouzanIpError(`[${j.code ?? "?"}] ${j.message ?? "调用失败"}${trace ? ` trace=${trace}` : ""}`));
  }
  return { payload: j.response ?? j.data ?? json, trace_id: trace, preview };
}

/**
 * 带版本回退的调用：读 registry 的 version_candidates，逐个版本尝试。
 * 只在"降级性错误"（gw 4005 / 未授权 / method not found / 不支持版本 / http 404）时切下一个版本；
 * 其他错误立即抛出。返回值携带实际命中的版本 + 每一版尝试摘要。
 */
export async function callYouzanApiWithVersionFallback(opts: {
  accessToken: string;
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  /** 若不传，从 registry 读 version_candidates ?? [version]。 */
  versions?: string[];
}): Promise<{
  payload: unknown;
  trace_id: string | null;
  preview: string;
  version: string;
  attempts: Array<{ version: string; ok: boolean; error?: string; trace?: string | null }>;
}> {
  const { YOUZAN_API_REGISTRY } = await import("./youzan-api-registry");
  const spec = YOUZAN_API_REGISTRY.find((s) => s.method === opts.method);
  const versions =
    opts.versions ?? spec?.version_candidates ?? (spec ? [spec.version] : []);
  if (versions.length === 0) {
    throw new Error(`callYouzanApiWithVersionFallback: 未找到 ${opts.method} 的版本候选`);
  }
  const attempts: Array<{ version: string; ok: boolean; error?: string; trace?: string | null }> = [];
  let lastError: unknown = null;
  for (const v of versions) {
    try {
      const r = await callYouzanApiVerbose({
        accessToken: opts.accessToken,
        method: opts.method,
        version: v,
        params: opts.params,
        timeoutMs: opts.timeoutMs,
      });
      attempts.push({ version: v, ok: true, trace: r.trace_id });
      return { ...r, version: v, attempts };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      attempts.push({ version: v, ok: false, error: msg.slice(0, 240) });
      lastError = e;
      const downgrade =
        /gw\s*4005|非法的\s*API|invalid\s*api|未授权|no\s*permission|not\s*authorized|method\s*not\s*found|不支持的版本|unsupported\s*version|HTTP\s*404|\[404\]/i.test(
          msg,
        );
      if (!downgrade) break;
    }
  }
  const finalMsg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `${opts.method} 所有版本 [${versions.join(", ")}] 都失败：${finalMsg}. attempts=${JSON.stringify(attempts).slice(0, 400)}`,
  );
}


export const getYouzanOutboundInfo = createServerFn({ method: "GET" }).handler(async () => {
  return getYouzanOutboundStatus();
});

type YouzanDiagnosticStep = {
  label: string;
  status: "ok" | "warn" | "error";
  message: string;
};

function parseDefaultYouzanCategoryId(rawValue: unknown) {
  if (typeof rawValue === "number") return rawValue;
  if (typeof rawValue === "string") return Number(rawValue) || 0;
  if (rawValue && typeof rawValue === "object") {
    return Number((rawValue as { id?: unknown }).id ?? 0) || 0;
  }
  return 0;
}

export const diagnoseYouzanListing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{
    ok: boolean;
    checkedAt: string;
    outbound: ReturnType<typeof getYouzanOutboundStatus>;
    steps: YouzanDiagnosticStep[];
  }> => {
    const steps: YouzanDiagnosticStep[] = [];
    const { data: setting } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "youzan_hq_default_category_id")
      .maybeSingle();
    const defaultCategoryId = parseDefaultYouzanCategoryId(
      (setting as { value?: unknown } | null)?.value,
    );
    steps.push(
      defaultCategoryId > 0
        ? { label: "有赞分组", status: "ok", message: `系统已保存自动同步分组 #${defaultCategoryId}` }
        : {
            label: "有赞分组",
            status: "ok",
            message: "还没保存分组也没关系；第一次推商品时系统会自动在有赞创建「ERP自动同步」。",
          },
    );

    let hq: ShopRow | null = null;
    let hqToken: string | null = null;
    try {
      hq = await getHqShop();
      hqToken = await ensureAccessToken(hq);
      await callYouzanApiVerbose({
        accessToken: hqToken,
        method: "youzan.shop.get",
        version: "3.0.0",
        params: {},
      });
      steps.push({ label: "总部授权", status: "ok", message: `总部店铺可以连接：${hq.shop_name}` });
    } catch (e) {
      steps.push({ label: "总部授权", status: "error", message: explainYouzanError(e) });
    }

    const { data: branch } = await supabase
      .from("youzan_shops")
      .select("*")
      .eq("role", "branch")
      .neq("status", "disabled")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!branch) {
      steps.push({ label: "门店授权", status: "warn", message: "还没有可用分店，暂时无法检查门店同步。" });
    } else {
      try {
        const branchShop = branch as ShopRow;
        const branchToken = await ensureAccessToken(branchShop);
        await callYouzanApiVerbose({
          accessToken: branchToken,
          method: "youzan.shop.get",
          version: "3.0.0",
          params: {},
        });
        steps.push({ label: "门店授权", status: "ok", message: `门店可以连接：${branchShop.shop_name}` });
      } catch (e) {
        steps.push({ label: "门店授权", status: "error", message: explainYouzanError(e) });
      }
    }

    if (!hqToken) {
      steps.push({ label: "推商品接口", status: "warn", message: "总部授权没通过，所以暂时不能检查推商品接口。" });
    } else {
      try {
        await callYouzanApiVerbose({
          accessToken: hqToken,
          method: "youzan.retail.open.spu.create",
          version: "3.0.0",
          params: {},
          timeoutMs: 20_000,
        });
        steps.push({ label: "推商品接口", status: "ok", message: "有赞接受了推商品接口。" });
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        if (/gw\s*4005|非法的\s*API|invalid\s*api/i.test(raw)) {
          steps.push({ label: "推商品接口", status: "error", message: explainYouzanError(e) });
        } else if (/参数|param|required|缺少|不能为空|invalid/i.test(raw)) {
          steps.push({
            label: "推商品接口",
            status: "ok",
            message: "有赞能识别推商品接口；刚才只是因为体检没真的传商品资料，所以返回参数提示，这是正常的。",
          });
        } else {
          steps.push({ label: "推商品接口", status: "warn", message: explainYouzanError(e) });
        }
      }
    }

    return {
      ok: steps.every((s) => s.status === "ok"),
      checkedAt: new Date().toISOString(),
      outbound: getYouzanOutboundStatus(),
      steps,
    };
  });

/** 进入同步前，把超过 30 秒还在 running 的旧记录直接标成失败，避免页面假活 */
async function reapStaleSyncLogs() {
  await supabase
    .from("youzan_sync_logs")
    .update({
      status: "error",
      error: "上次同步进程中断或超时（自动重置）—— 可能是 Worker 单次请求超时，请改用后台同步",
      finished_at: new Date().toISOString(),
    } as never)
    .eq("status", "running")
    .lt("started_at", new Date(Date.now() - 10 * 60_000).toISOString());
}

// ============================================================
// listShops
// ============================================================
export const listYouzanShops = createServerFn({ method: "GET" }).handler(
  async () => {
    const { data, error } = await supabase
      .from("youzan_shops")
      .select("*")
      .order("role", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return { shops: data ?? [] };
  },
);

// ============================================================
// listSyncLogs
// ============================================================
export const listYouzanSyncLogs = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z
      .object({ limit: z.number().min(1).max(200).default(50) })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    await reapStaleSyncLogs();
    const { data: rows, error } = await supabase
      .from("youzan_sync_logs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    return { logs: rows ?? [] };
  });

// ============================================================
// pingYouzanShop — 测试连接
// ============================================================
export const pingYouzanShop = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ shop_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const shop = await getShopOr404({ shop_id: data.shop_id });
    const { data: log } = await supabase
      .from("youzan_sync_logs")
      .insert({
        shop_id: shop.id,
        kdt_id: shop.kdt_id,
        action: "ping",
        status: "running",
      } as never)
      .select("id")
      .single();

    try {
      const token = await ensureAccessToken(shop);
      const resp = (await callYouzanApi({
        accessToken: token,
        method: "youzan.shop.get",
        version: "3.0.0",
        params: {},
      })) as { shop?: { name?: string; id?: number } };

      const okMsg = `店铺：${resp.shop?.name ?? "(无名)"} / kdt_id=${resp.shop?.id ?? shop.kdt_id}`;
      await supabase
        .from("youzan_shops")
        .update({
          last_ping_at: new Date().toISOString(),
          last_ping_ok: true,
          last_ping_msg: okMsg,
        } as never)
        .eq("id", shop.id);
      if (log?.id) {
        await supabase
          .from("youzan_sync_logs")
          .update({
            status: "ok",
            message: okMsg,
            finished_at: new Date().toISOString(),
          } as never)
          .eq("id", log.id);
      }
      return { ok: true, message: okMsg };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabase
        .from("youzan_shops")
        .update({
          last_ping_at: new Date().toISOString(),
          last_ping_ok: false,
          last_ping_msg: msg,
        } as never)
        .eq("id", shop.id);
      if (log?.id) {
        await supabase
          .from("youzan_sync_logs")
          .update({
            status: "error",
            error: msg,
            finished_at: new Date().toISOString(),
          } as never)
          .eq("id", log.id);
      }
      return { ok: false, message: msg };
    }
  });

// ============================================================
// addYouzanShop / updateYouzanShop / removeYouzanShop
// （手动维护，等 Phase 1 的 syncStoresFromHq 上线后可改自动）
// ============================================================
const ShopInput = z.object({
  kdt_id: z.number().int().positive(),
  shop_name: z.string().min(1).max(120),
  role: z.enum(["hq", "branch"]).default("branch"),
  parent_kdt_id: z.number().int().positive().nullable().optional(),
  status: z.enum(["active", "disabled", "expired"]).default("active"),
  notes: z.string().nullable().optional(),
});

export const addYouzanShop = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ShopInput.parse(input))
  .handler(async ({ data }) => {
    const { data: row, error } = await supabase
      .from("youzan_shops")
      .insert(data as never)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return { shop: row };
  });

export const updateYouzanShop = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        patch: ShopInput.partial(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { error } = await supabase
      .from("youzan_shops")
      .update(data.patch as never)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const removeYouzanShop = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { error } = await supabase
      .from("youzan_shops")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ============================================================
// listAuthorizedShopsFromHQ — 用总部 token 拉取连锁分店列表
// ------------------------------------------------------------
// 自用型应用走 grant_type=silent，所有「已在有赞云后台勾选授权」
// 的 kdt_id 都能直接换 token。这里尝试用总部 token 调连锁 API
// 枚举所有子店铺；如果接口不可用，前端就给出引导文案。
// ============================================================
type ChainShop = {
  kdt_id: number;
  shop_name: string;
  shop_type?: string | null;
  address?: string | null;
  already_added: boolean;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function collectShopArrays(raw: unknown) {
  const roots = [raw, asObject(raw)?.response, asObject(raw)?.data].filter(Boolean);
  const keys = [
    "shop_list",
    "shopList",
    "shops",
    "list",
    "items",
    "records",
    "shop_infos",
    "shopInfoList",
    "offline_shop_list",
  ];
  const found: unknown[] = [];
  const visit = (node: unknown, depth = 0) => {
    if (depth > 3 || !node) return;
    if (Array.isArray(node)) {
      found.push(...node);
      return;
    }
    const obj = asObject(node);
    if (!obj) return;
    for (const key of keys) visit(obj[key], depth + 1);
    for (const key of ["data", "response", "result", "paginator", "page"]) {
      visit(obj[key], depth + 1);
    }
  };
  roots.forEach((root) => visit(root));
  return found;
}

export const listAuthorizedShopsFromHQ = createServerFn({ method: "POST" })
  .handler(async (): Promise<{ shops: ChainShop[]; error: string | null }> => {
    // 1. 找总部
    const { data: hq, error: hqErr } = await supabase
      .from("youzan_shops")
      .select("*")
      .eq("role", "hq")
      .maybeSingle();
    if (hqErr) throw new Error(hqErr.message);
    if (!hq) {
      return {
        shops: [],
        error: "尚未配置总部门店。请先在有赞云后台授权总部 kdt_id 并添加。",
      };
    }
    const hqRow = hq as ShopRow;

    // 2. 取总部 token
    let token: string;
    try {
      token = await ensureAccessToken(hqRow);
    } catch (e) {
      return {
        shops: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }

    // 3. 查本地已有 kdt_id
    const { data: existing } = await supabase
      .from("youzan_shops")
      .select("kdt_id");
    const existingSet = new Set(
      ((existing ?? []) as Array<{ kdt_id: number }>).map((r) => r.kdt_id),
    );

    // 4. 调有赞连锁 API（多个备选方法，按可用性逐个尝试）
    const candidates: Array<{ method: string; version: string }> = [
      { method: "youzan.retail.shop.list.query", version: "1.0.0" },
      { method: "youzan.retail.shop.query", version: "1.0.0" },
      { method: "youzan.shop.list.get", version: "1.0.0" },
    ];

    let raw: unknown = null;
    let lastErr = "";
    for (const c of candidates) {
      try {
        raw = await callYouzanApi({
          accessToken: token,
          method: c.method,
          version: c.version,
          params: { page_no: 1, page_size: 20 },
        });
        lastErr = "";
        break;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }

    if (!raw) {
      return {
        shops: [],
        error: `无法从有赞拉取分店列表（${lastErr}）。请在有赞云后台「自用型应用 → 授权店铺」勾选分店后重试。`,
      };
    }

    // 5. 解析（有赞返回结构有多种，做容错）
    const seen = new Set<number>();
    const shops: ChainShop[] = collectShopArrays(raw).map((item) => {
        const s = asObject(item) ?? {};
        const kdtId = Number(s.kdt_id ?? s.kdtId ?? s.shop_id ?? s.shopId ?? s.id ?? 0);
        return {
          kdt_id: kdtId,
          shop_name: String(s.shop_name ?? s.shopName ?? s.store_name ?? s.storeName ?? s.name ?? `店铺 ${kdtId}`),
          shop_type: (s.shop_type ?? s.shopType ?? s.type) as string | null,
          address: (s.address ?? s.full_address ?? s.fullAddress) as string | null,
          already_added: existingSet.has(kdtId),
        };
      })
      .filter((s) => {
        if (s.kdt_id <= 0 || seen.has(s.kdt_id)) return false;
        seen.add(s.kdt_id);
        return true;
      });

    if (shops.length === 0) {
      return {
        shops: [],
        error: "总部授权可用，但有赞连锁门店列表接口没有返回分店。可以在下方手动粘贴已授权分店的 kdt_id，系统会逐个验证授权后添加。",
      };
    }

    return { shops, error: null };
  });

// ============================================================
// batchImportShops — 一次批量授权并入库
// ============================================================
export const batchImportShops = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        shops: z
          .array(
            z.object({
              kdt_id: z.number().int().positive(),
              shop_name: z.string().min(1).max(120),
              parent_kdt_id: z.number().int().positive().nullable().optional(),
            }),
          )
          .min(1)
          .max(50),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    let added = 0;
    let failed = 0;
    const errors: Array<{ kdt_id: number; error: string }> = [];

    for (const s of data.shops) {
      try {
        // 先 upsert 一条记录（如果存在就跳过）
        const { data: existing } = await supabase
          .from("youzan_shops")
          .select("id")
          .eq("kdt_id", s.kdt_id)
          .maybeSingle();
        if (existing) continue;

        // 试着换一次 token 验证授权
        const t = await fetchSilentToken(s.kdt_id);

        const { data: inserted, error } = await supabase
          .from("youzan_shops")
          .insert({
            kdt_id: s.kdt_id,
            shop_name: s.shop_name,
            role: "branch",
            parent_kdt_id: s.parent_kdt_id ?? null,
            status: "active",
            access_token: t.access_token,
            refresh_token: t.refresh_token,
            token_expires_at: t.token_expires_at,
            authorized_at: new Date().toISOString(),
          } as never)
          .select("*")
          .single();
        if (error) throw new Error(error.message);
        added += 1;

        // 新加店铺立即跑一次商品同步（不阻塞失败）
        if (inserted) {
          runItemsSyncForShop(inserted as ShopRow).catch(() => {});
        }
      } catch (e) {
        failed += 1;
        errors.push({
          kdt_id: s.kdt_id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { added, failed, errors };
  });

// ============================================================
// 内部：取总部 token（零售连锁版很多 retail.open.* 接口都要用总部 token + 分店 kdt_id）
// ============================================================
export async function getHqShop(): Promise<ShopRow> {
  const { data, error } = await supabase
    .from("youzan_shops")
    .select("*")
    .eq("role", "hq")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("尚未配置总部门店（role=hq）");
  return data as ShopRow;
}


// ============================================================
// 内部：从有赞零售返回结构里挖出 SPU 列表
// ============================================================
function pickSpuRows(raw: unknown): Array<Record<string, unknown>> {
  const visited = new Set<unknown>();
  const arrays: Array<Array<Record<string, unknown>>> = [];
  const keys = [
    "spu_list",
    "spuList",
    "spus",
    "items",
    "item_list",
    "itemList",
    "online_spu_list",
    "onlineSpuList",
    "list",
    "records",
    "rows",
  ];
  const visit = (node: unknown, depth = 0) => {
    if (!node || depth > 5 || visited.has(node)) return;
    if (typeof node !== "object") return;
    visited.add(node);
    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === "object") {
        arrays.push(node as Array<Record<string, unknown>>);
      }
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const k of keys) if (k in obj) visit(obj[k], depth + 1);
    for (const k of ["data", "response", "result", "paginator", "page"]) {
      if (k in obj) visit(obj[k], depth + 1);
    }
  };
  visit(raw);
  if (arrays.length === 0) return [];
  arrays.sort((a, b) => b.length - a.length);
  return arrays[0];
}

function normalizeSpuRow(it: Record<string, unknown>, shop: ShopRow) {
  const itemId = Number(
    it.spu_id ?? it.spuId ?? it.item_id ?? it.itemId ?? it.id ?? 0,
  );
  if (!itemId) return null;
  const skus = Array.isArray(it.sku_list ?? it.skuList ?? it.skus)
    ? ((it.sku_list ?? it.skuList ?? it.skus) as Array<Record<string, unknown>>)
    : [];
  const skuPrices = skus
    .map((s) => Number(s.price ?? s.retail_price ?? s.sale_price ?? 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  const priceRaw =
    (skuPrices.length ? Math.min(...skuPrices) : null) ??
    it.price ??
    it.retail_price ??
    it.min_price ??
    it.sale_price ??
    0;
  const priceNum = Number(priceRaw);
  // 总部 SPU 接口图片字段：photo_url 可能是 [{url}]、字符串数组，也可能是 JSON 字符串
  let pic: string | null = null;
  let photoUrl: unknown = it.photo_url ?? it.photoUrl;
  if (typeof photoUrl === "string") {
    try {
      photoUrl = JSON.parse(photoUrl);
    } catch {
      // ignore
    }
  }
  if (Array.isArray(photoUrl) && photoUrl.length) {
    const first = photoUrl[0];
    pic =
      typeof first === "string"
        ? first
        : first && typeof first === "object" && (first as Record<string, unknown>).url
          ? String((first as Record<string, unknown>).url)
          : null;
  }
  pic =
    pic ??
    (it.pic_url as string) ??
    (it.picUrl as string) ??
    (it.main_pic as string) ??
    (it.mainPic as string) ??
    (Array.isArray(it.pic_urls) ? (it.pic_urls[0] as string) : null) ??
    (Array.isArray(it.images) ? (it.images[0] as string) : null) ??
    null;
  const stockSum = skus.reduce(
    (s, x) => s + (Number(x.stock_num ?? x.stockNum ?? x.quantity ?? x.stock ?? 0) || 0),
    0,
  );
  const statusRaw = it.status ?? it.online_status ?? it.sale_status;
  const statusNum = Number(statusRaw);
  const isListed =
    Number.isFinite(statusNum) && statusNum > 0 ? statusNum === 1 : true;
  return {
    shop_id: shop.id,
    kdt_id: shop.kdt_id,
    item_id: itemId,
    title: String(
      it.product_name ??
        it.productName ??
        it.title ??
        it.name ??
        it.spu_name ??
        it.spuName ??
        "",
    ),
    price: Number.isFinite(priceNum) ? priceNum : 0,
    stock_qty:
      stockSum ||
      Number(it.stock_num ?? it.stockNum ?? it.total_stock ?? it.quantity ?? 0) ||
      0,
    is_listed: isListed,
    pic_url: pic,
    raw: it,
  };
}

// ============================================================
// 内部：单店商品同步（零售连锁版）
// ------------------------------------------------------------
// HQ      → youzan.retail.open.spu.query.3.0.0（总部商品库 SPU）
// Branch  → youzan.retail.open.online.spu.query.1.0.0（门店在售 SPU，
//           用总部 token + 分店 kdt_id）
// ============================================================
async function runItemsSyncForShop(
  shop: ShopRow,
): Promise<{ ok: boolean; count: number; message: string }> {
  const { data: log } = await supabase
    .from("youzan_sync_logs")
    .insert({
      shop_id: shop.id,
      kdt_id: shop.kdt_id,
      action: "items",
      status: "running",
    } as never)
    .select("id")
    .single();

  let totalReturned = 0;
  let totalUpserted = 0;
  let lastPreview = "";
  let lastTrace: string | null = null;
  const seen = new Set<number>();
  const attemptMsgs: string[] = [];

  try {
    const pageSize = 20;

    type Attempt = {
      label: string;
      method: string;
      version: string;
      token: string;
      buildParams: (page: number) => Record<string, unknown>;
    };
    const attempts: Attempt[] = [];

    if (shop.role === "hq") {
      const token = await ensureAccessToken(shop);
      attempts.push({
        label: "retail.open.spu.query.3.0.0",
        method: "youzan.retail.open.spu.query",
        version: "3.0.0",
        token,
        buildParams: (p) => ({ page_no: p, page_size: pageSize }),
      });
    } else {
      const hq = await getHqShop();
      const hqToken = await ensureAccessToken(hq);
      attempts.push({
        label: "retail.open.online.spu.query.1.0.0",
        method: "youzan.retail.open.online.spu.query",
        version: "1.0.0",
        token: hqToken,
        buildParams: (p) => ({
          page_no: p,
          page_size: pageSize,
          kdt_id: shop.kdt_id,
        }),
      });
    }

    for (const m of attempts) {
      let page = 1;
      let attemptReturned = 0;
      let attemptUpserted = 0;
      try {
        for (;;) {
          const r = await callYouzanApiVerbose({
            accessToken: m.token,
            method: m.method,
            version: m.version,
            params: m.buildParams(page),
            timeoutMs: 20_000,
          });
          lastPreview = r.preview;
          lastTrace = r.trace_id;
          const items = pickSpuRows(r.payload);
          attemptReturned += items.length;
          if (items.length === 0) break;

          const rows = items
            .map((it) => normalizeSpuRow(it, shop))
            .filter((r): r is NonNullable<typeof r> => !!r && !seen.has(r.item_id))
            .map((r) => {
              seen.add(r.item_id);
              return r;
            });

          if (rows.length > 0) {
            const { error } = await supabase
              .from("youzan_items")
              .upsert(rows as never, { onConflict: "kdt_id,item_id" });
            if (error) throw new Error(error.message);
            attemptUpserted += rows.length;
          }
          if (items.length < pageSize) break;
          page += 1;
          if (page > 200) break;
        }
        attemptMsgs.push(`${m.label}: 返回 ${attemptReturned} 入库 ${attemptUpserted}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        attemptMsgs.push(`${m.label}: ${msg}`);
      }
      totalReturned += attemptReturned;
      totalUpserted += attemptUpserted;
      if (attemptUpserted > 0) break;
    }

    const status = totalUpserted > 0 ? "ok" : "empty";
    let msg = `商品同步 入库 ${totalUpserted} / 返回 ${totalReturned}｜${attemptMsgs.join(" / ")}`;
    if (totalUpserted === 0 && lastPreview) {
      msg += `｜末次响应: ${lastPreview}`;
      if (lastTrace) msg += ` (trace=${lastTrace})`;
    }
    if (log?.id) {
      await supabase
        .from("youzan_sync_logs")
        .update({
          status,
          count_in: totalUpserted,
          count_out: totalReturned,
          message: msg,
          error: null,
          finished_at: new Date().toISOString(),
        } as never)
        .eq("id", log.id);
    }
    return { ok: status !== "empty", count: totalUpserted, message: msg };
  } catch (err) {
    let msg = `${err instanceof Error ? err.message : String(err)}｜${attemptMsgs.join(" / ")}`;
    if (lastPreview) msg += `｜末次响应: ${lastPreview}`;
    if (lastTrace) msg += ` (trace=${lastTrace})`;
    if (log?.id) {
      await supabase
        .from("youzan_sync_logs")
        .update({
          status: "error",
          count_in: totalUpserted,
          count_out: totalReturned,
          error: msg.slice(0, 4000),
          finished_at: new Date().toISOString(),
        } as never)
        .eq("id", log.id);
    }
    return { ok: false, count: totalUpserted, message: msg };
  }
}

export const syncYouzanItems = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ shop_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    await reapStaleSyncLogs();
    const shop = await getShopOr404({ shop_id: data.shop_id });
    return runItemsSyncForShop(shop);
  });


// ============================================================
// 内部：从有赞零售返回结构里挖出订单/交易列表
// ============================================================
function pickTradeRows(raw: unknown): Array<Record<string, unknown>> {
  const visited = new Set<unknown>();
  const arrays: Array<Array<Record<string, unknown>>> = [];
  const keys = [
    "orders",
    "order_list",
    "orderList",
    "trades",
    "trade_list",
    "tradeList",
    "full_order_info_list",
    "list",
    "records",
    "rows",
  ];
  const visit = (node: unknown, depth = 0) => {
    if (!node || depth > 5 || visited.has(node)) return;
    if (typeof node !== "object") return;
    visited.add(node);
    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === "object") {
        arrays.push(node as Array<Record<string, unknown>>);
      }
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const k of keys) if (k in obj) visit(obj[k], depth + 1);
    for (const k of ["data", "response", "result", "paginator", "page"]) {
      if (k in obj) visit(obj[k], depth + 1);
    }
  };
  visit(raw);
  if (arrays.length === 0) return [];
  arrays.sort((a, b) => b.length - a.length);
  return arrays[0];
}

// ============================================================
// 内部：把一条 trade（无论 trades.sold.get / retail.* 哪种结构）
// 平展成 { k -> v } lookup，再用多 key 别名取字段。
// ------------------------------------------------------------
// 有赞 4.x 返回结构：
//   full_order_info_list[i] = { full_order_info: { tradeBase, orderInfo, payInfo, ... } }
// 字段名可能是 snake_case 也可能 camelCase，金额/时间放在 payInfo 里
// ============================================================
function flattenTrade(trade: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const seen = new Set<unknown>();
  const SUB_KEYS = [
    "full_order_info",
    "fullOrderInfo",
    "tradeBase",
    "trade_base",
    "trade",
    "orderInfo",
    "order_info",
    "payInfo",
    "pay_info",
    "buyerInfo",
    "buyer_info",
    "logisticsInfo",
    "logistics_info",
    "promotionDetail",
    "extraInfo",
  ];
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || seen.has(node) || depth > 4) return;
    seen.add(node);
    if (Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || typeof v !== "object") {
        if (!(k in out)) out[k] = v;
      } else if (SUB_KEYS.includes(k)) {
        walk(v, depth + 1);
      }
    }
  };
  walk(trade, 0);
  return out;
}

function pickStr(n: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = n[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return null;
}
function pickNum(n: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = n[k];
    if (v !== undefined && v !== null && v !== "") {
      const num = Number(v);
      if (!Number.isNaN(num)) return num;
    }
  }
  return 0;
}
// 有赞返回的时间多为 "YYYY-MM-DD HH:mm:ss"（北京时间，无时区），
// 直接 new Date 会按本机时区解析。这里强制按 +08:00 解析为 UTC ISO。
function parseYzTime(raw: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s || s === "0" || s.startsWith("1970") || s.startsWith("0000")) return null;
  if (/^\d{10,13}$/.test(s)) {
    const ms = s.length === 10 ? Number(s) * 1000 : Number(s);
    return new Date(ms).toISOString();
  }
  if (/T/.test(s) || /Z$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ============================================================
// 从原始 trade JSON 里抽取展示字段（商品摘要 / 收货 / 买家 / 件数 …）
// ============================================================
type EnrichedFields = {
  buyer_nick: string | null;
  buyer_open_id: string | null;
  item_count: number | null;
  sku_count: number | null;
  item_titles: string | null;
  first_item_image: string | null;
  receiver_name: string | null;
  receiver_tel: string | null;
  receiver_address: string | null;
  outer_transaction_no: string | null;
  post_fee: number | null;
  status_text: string | null;
};

function pickFirst(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return null;
}
function pickFirstNum(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") {
      const n = Number(v);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}

export function enrichOrderFields(
  trade: Record<string, unknown>,
  status: string | null,
): EnrichedFields {
  const fullOrder = ((trade.full_order_info ?? trade.fullOrderInfo ?? {}) as Record<string, unknown>);
  const ordersArr = (fullOrder.orders as Array<Record<string, unknown>> | undefined) ?? [];
  const addr = ((fullOrder.address_info ?? fullOrder.addressInfo ?? {}) as Record<string, unknown>);
  const buyer = ((fullOrder.buyer_info ?? fullOrder.buyerInfo ?? {}) as Record<string, unknown>);
  const payInfo = ((fullOrder.pay_info ?? fullOrder.payInfo ?? {}) as Record<string, unknown>);

  // 件数：累加所有子单 num
  let itemCount = 0;
  for (const o of ordersArr) itemCount += Number((o?.num as unknown) ?? 0) || 0;

  // 商品摘要
  const titles = ordersArr
    .map((o) => String((o?.title as unknown) ?? "").trim())
    .filter(Boolean);
  let itemTitles: string | null = null;
  if (titles.length > 0) {
    const head = titles.slice(0, 3).join("、");
    itemTitles = titles.length > 3 ? `${head} 等 ${titles.length} 件` : head;
  }

  // 首张商品图：orders[0].pic_url / sku_pic_url / image
  let firstImg: string | null = null;
  if (ordersArr[0]) {
    firstImg = pickFirst(ordersArr[0] as Record<string, unknown>, [
      "pic_url",
      "picUrl",
      "sku_pic_url",
      "skuPicUrl",
      "pic_thumb_url",
      "image",
      "img_url",
    ]);
  }

  // 买家
  const buyerNick =
    pickFirst(buyer, ["fans_nickname", "fansNickname", "buyer_nick", "buyerNick", "nickname", "nick"]) ??
    (pickFirst(buyer, ["outer_user_id", "outerUserId"]) ?? null);
  const buyerOpenId = pickFirst(buyer, ["yz_open_id", "yzOpenId", "openId", "open_id"]);

  // 收货
  const receiverName = pickFirst(addr, ["receiver_name", "receiverName"]);
  const receiverTel = pickFirst(addr, ["receiver_tel", "receiverTel", "receiver_mobile", "receiverMobile"]);
  const parts = [
    pickFirst(addr, ["delivery_province", "deliveryProvince", "province"]),
    pickFirst(addr, ["delivery_city", "deliveryCity", "city"]),
    pickFirst(addr, ["delivery_district", "deliveryDistrict", "district"]),
    pickFirst(addr, ["delivery_address", "deliveryAddress", "address"]),
  ].filter(Boolean);
  const receiverAddress = parts.length > 0 ? parts.join(" ") : null;

  // 支付
  let outerTxn: string | null = null;
  const outerArr = payInfo.outer_transactions ?? payInfo.outerTransactions;
  if (Array.isArray(outerArr) && outerArr.length > 0) outerTxn = String(outerArr[0] ?? "") || null;
  const postFee = pickFirstNum(payInfo, ["post_fee", "postFee"]);

  return {
    buyer_nick: buyerNick,
    buyer_open_id: buyerOpenId,
    item_count: itemCount > 0 ? itemCount : null,
    sku_count: ordersArr.length > 0 ? ordersArr.length : null,
    item_titles: itemTitles,
    first_item_image: firstImg,
    receiver_name: receiverName,
    receiver_tel: receiverTel,
    receiver_address: receiverAddress,
    outer_transaction_no: outerTxn,
    post_fee: postFee,
    status_text: status ? yzStatusText(status) : null,
  };
}






// ============================================================
// 内部：单店订单同步（零售连锁版）
// ------------------------------------------------------------
// HQ      → 跳过，总部没有销售
// Branch  → 优先 youzan.trades.sold.get（通用交易接口，offline_id=分店 kdt_id）
//           兜底再试 retail.trade.order.search / retail.trade.search
// ============================================================
async function runOrdersSyncForShop(
  shop: ShopRow,
  startDate: Date,
  endDate: Date,
): Promise<{ ok: boolean; count: number; message: string }> {
  const fmt = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  // HQ 不同步订单
  if (shop.role === "hq") {
    await supabase.from("youzan_sync_logs").insert({
      shop_id: shop.id,
      kdt_id: shop.kdt_id,
      action: "orders",
      status: "skipped",
      message: "总部门店无销售数据（已跳过）",
      finished_at: new Date().toISOString(),
    } as never);
    return { ok: true, count: 0, message: "总部门店无销售数据（已跳过）" };
  }

  const { data: log } = await supabase
    .from("youzan_sync_logs")
    .insert({
      shop_id: shop.id,
      kdt_id: shop.kdt_id,
      action: "orders",
      status: "running",
      message: `${fmt(startDate)} ~ ${fmt(endDate)}`,
    } as never)
    .select("id")
    .single();

  let totalReturned = 0;
  let totalUpserted = 0;
  const attemptMsgs: string[] = [];
  let lastPreview = "";
  let lastTrace: string | null = null;

  try {
    const hq = await getHqShop();
    const token = await ensureAccessToken(hq);
    const pageSize = 20;

    const attempts: Array<{
      label: string;
      method: string;
      version: string;
      buildParams: (page: number) => Record<string, unknown>;
    }> = [
      {
        label: "trades.sold.get@4.0.4",
        method: "youzan.trades.sold.get",
        version: "4.0.4",
        buildParams: (page) => ({
          page_no: page,
          page_size: pageSize,
          offline_id: shop.kdt_id,
          start_update: fmt(startDate),
          end_update: fmt(endDate),
        }),
      },
      {
        label: "trades.sold.get@4.0.2",
        method: "youzan.trades.sold.get",
        version: "4.0.2",
        buildParams: (page) => ({
          page_no: page,
          page_size: pageSize,
          offline_id: shop.kdt_id,
          start_update: fmt(startDate),
          end_update: fmt(endDate),
        }),
      },
      {
        label: "trades.sold.get@4.0.0",
        method: "youzan.trades.sold.get",
        version: "4.0.0",
        buildParams: (page) => ({
          page_no: page,
          page_size: pageSize,
          offline_id: shop.kdt_id,
          start_update: fmt(startDate),
          end_update: fmt(endDate),
        }),
      },
    ];

    let sampleRaw = "";
    let sampleMapped = "";

    for (const m of attempts) {
      let attemptReturned = 0;
      let attemptUpserted = 0;
      let attemptDropped = 0;
      let page = 1;
      try {
        for (;;) {
          const params: Record<string, unknown> = m.buildParams(page);
          const r = await callYouzanApiVerbose({
            accessToken: token,
            method: m.method,
            version: m.version,
            params,
          });
          lastPreview = r.preview;
          lastTrace = r.trace_id;
          const trades = pickTradeRows(r.payload);
          attemptReturned += trades.length;
          if (trades.length === 0) break;

          if (!sampleRaw && trades[0]) {
            sampleRaw = JSON.stringify(trades[0]).slice(0, 3500);
          }

          const rows = trades
            .map((t) => {
              const n = flattenTrade(t);
              const tid = pickStr(n, [
                "tid",
                "orderNo",
                "order_no",
                "bizOrderId",
                "biz_order_id",
                "oid",
                "order_id",
                "orderId",
              ]);
              if (!tid) {
                attemptDropped += 1;
                return null;
              }
              const payTimeStr = pickStr(n, [
                "pay_time",
                "payTime",
                "paidTime",
                "paid_time",
              ]);
              const createdStr = pickStr(n, [
                "created",
                "createTime",
                "create_time",
                "tradeCreateTime",
                "trade_create_time",
              ]);
              const status =
                pickStr(n, [
                  "status",
                  "tradeStatus",
                  "trade_status",
                  "orderStatus",
                  "order_status",
                ]) ?? null;
              const buyer =
                pickStr(n, [
                  "buyer_nick",
                  "buyerNick",
                  "buyerName",
                  "buyer_name",
                  "buyerId",
                ]) ?? null;
              const payment = pickNum(n, [
                "payment",
                "payAmount",
                "pay_amount",
                "actualPayFee",
                "actual_pay_fee",
              ]);
              const totalFee = pickNum(n, [
                "total_fee",
                "totalFee",
                "orderAmount",
                "order_amount",
                "totalPrice",
              ]);
              const num = pickNum(n, [
                "num",
                "itemTotalNum",
                "item_total_num",
                "totalNum",
                "total_num",
                "buyNum",
              ]);
              const payTypeRaw = pickStr(n, ["pay_type", "payType", "paymentType"]);
              const payType = payTypeRaw && !Number.isNaN(Number(payTypeRaw))
                ? Number(payTypeRaw)
                : null;
              const enriched = enrichOrderFields(t as Record<string, unknown>, status);
              // 件数：优先用子单累加（更准），否则回退到 num 字段
              const finalNum = enriched.item_count ?? (num || null);
              const row = {
                shop_id: shop.id,
                kdt_id: shop.kdt_id,
                tid,
                status,
                buyer_nick: enriched.buyer_nick ?? buyer,
                payment,
                total_fee: totalFee,
                num: finalNum,
                pay_type: payType,
                pay_time: parseYzTime(payTimeStr),
                created_time: parseYzTime(createdStr),
                raw: t,
                buyer_open_id: enriched.buyer_open_id,
                item_count: enriched.item_count,
                sku_count: enriched.sku_count,
                item_titles: enriched.item_titles,
                first_item_image: enriched.first_item_image,
                receiver_name: enriched.receiver_name,
                receiver_tel: enriched.receiver_tel,
                receiver_address: enriched.receiver_address,
                outer_transaction_no: enriched.outer_transaction_no,
                post_fee: enriched.post_fee,
                status_text: enriched.status_text,
              };
              if (!sampleMapped) sampleMapped = JSON.stringify(row).slice(0, 1500);
              return row;
            })
            .filter((r): r is NonNullable<typeof r> => r !== null);

          if (rows.length > 0) {
            const { error } = await supabase
              .from("youzan_orders")
              .upsert(rows as never, { onConflict: "kdt_id,tid" });
            if (error) throw new Error(error.message);
            attemptUpserted += rows.length;
          }
          if (trades.length < pageSize) break;
          page += 1;
          if (page > 500) break;
        }
        const dropTxt = attemptDropped > 0 ? ` 丢弃 ${attemptDropped}` : "";
        attemptMsgs.push(`${m.label}: 返回 ${attemptReturned} 入库 ${attemptUpserted}${dropTxt}`);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        attemptMsgs.push(`${m.label}: ${errMsg}`);
      }
      totalReturned += attemptReturned;
      totalUpserted += attemptUpserted;
      if (attemptReturned > 0) break;
    }

    const status = totalReturned > 0 ? (totalUpserted > 0 ? "ok" : "empty") : "empty";
    let msg = `订单同步 入库 ${totalUpserted} / 返回 ${totalReturned}（${fmt(startDate)} ~ ${fmt(endDate)}）｜${attemptMsgs.join(" / ")}`;
    if (totalReturned === 0 && lastPreview) {
      msg += `｜末次响应: ${lastPreview}`;
      if (lastTrace) msg += ` (trace=${lastTrace})`;
    }
    if (totalReturned > 0 && totalUpserted === 0 && sampleRaw) {
      msg += `｜原始样本: ${sampleRaw}`;
    } else if (sampleMapped) {
      msg += `｜样本: ${sampleMapped}`;
    }

    if (log?.id) {
      await supabase
        .from("youzan_sync_logs")
        .update({
          status,
          count_in: totalUpserted,
          count_out: totalReturned,
          message: msg,
          error: null,
          finished_at: new Date().toISOString(),
        } as never)
        .eq("id", log.id);
    }
    return { ok: status !== "empty", count: totalUpserted, message: msg };
  } catch (err) {
    let msg = `${err instanceof Error ? err.message : String(err)}｜${attemptMsgs.join(" / ")}`;
    if (lastPreview) msg += `｜末次响应: ${lastPreview}`;
    if (lastTrace) msg += ` (trace=${lastTrace})`;
    if (log?.id) {
      await supabase
        .from("youzan_sync_logs")
        .update({
          status: "error",
          count_in: totalUpserted,
          count_out: totalReturned,
          error: msg.slice(0, 4000),
          finished_at: new Date().toISOString(),
        } as never)
        .eq("id", log.id);
    }
    return { ok: false, count: totalUpserted, message: msg };
  }
}

// ============================================================
// runShopSyncCore —— 给后台 worker 调（不走 createServerFn 中间件）
// ============================================================
export async function runShopSyncCore(opts: {
  shop_id: string;
  action: "items" | "orders";
  days?: number;
}): Promise<{ ok: boolean; count: number; message: string }> {
  await reapStaleSyncLogs();
  const shop = await getShopOr404({ shop_id: opts.shop_id });
  if (opts.action === "items") return runItemsSyncForShop(shop);
  const days = opts.days ?? 30;
  const end = new Date();
  const start = new Date(Date.now() - days * 86_400_000);
  return runOrdersSyncForShop(shop, start, end);
}


export const syncYouzanOrders = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        shop_id: z.string().uuid(),
        start: z.string().optional(),
        end: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await reapStaleSyncLogs();
    const shop = await getShopOr404({ shop_id: data.shop_id });
    const endDate = data.end ? new Date(data.end) : new Date();
    const startDate = data.start
      ? new Date(data.start)
      : new Date(Date.now() - 30 * 86_400_000);
    return runOrdersSyncForShop(shop, startDate, endDate);
  });

// ============================================================
// syncAllShops — 一键同步全部门店（后台模式）
// ------------------------------------------------------------
// 把每店 items / orders 拆成单独的 HTTP 任务，立刻投递到
// /api/public/hooks/youzan-sync-worker（fire-and-forget），
// 避免在一次请求里串行跑光 Worker 单请求 CPU/wall 时间预算。
// 前端通过轮询 youzan_sync_logs 拿到进度。
// ============================================================
export const syncAllShops = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({ days: z.number().int().min(1).max(180).default(60) })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    await reapStaleSyncLogs();
    const { data: shopsRaw, error } = await supabase
      .from("youzan_shops")
      .select("*")
      .eq("status", "active");
    if (error) throw new Error(error.message);
    const shops = (shopsRaw ?? []) as ShopRow[];

    // 改为派发到独立 worker route：主请求快速返回，实际进度通过
    // youzan_sync_logs 轮询观察；订单只同步分店，总部不再派发 orders。
    const origin = new URL(getRequestUrl()).origin;
    let dispatched = 0;
    for (const shop of shops) {
      for (const action of getYouzanSyncActions(shop)) {
        dispatchYouzanSyncWorker({
          origin,
          shop_id: shop.id,
          action,
          days: data.days,
        });
        dispatched += 1;
      }
    }


    return {
      shopCount: shops.length,
      dispatched,
      message: `已派发 ${dispatched} 个同步任务到后台，进度请看下方「同步明细」`,
    };
  });

// ============================================================
// listShopOrders — 门店订单列表（订单管理页用）
// ============================================================
export const listShopOrders = createServerFn({ method: "GET" }).handler(
  async () => {
    const [ordersRes, shopsRes] = await Promise.all([
      supabase
        .from("youzan_orders")
        .select(
          "id, tid, kdt_id, shop_id, status, status_text, buyer_nick, buyer_open_id, payment, total_fee, num, item_count, sku_count, item_titles, first_item_image, receiver_name, receiver_tel, receiver_address, outer_transaction_no, post_fee, pay_time, created_time, raw",
        )
        .order("pay_time", { ascending: false, nullsFirst: false })
        .limit(2000),
      supabase.from("youzan_shops").select("id, shop_name, kdt_id"),
    ]);
    if (ordersRes.error) throw new Error(ordersRes.error.message);
    if (shopsRes.error) throw new Error(shopsRes.error.message);
    return { orders: ordersRes.data ?? [], shops: shopsRes.data ?? [] };
  },
);

// ============================================================
// backfillShopOrders — 用 raw 重新跑 enrich，把新字段补齐
// ============================================================
export const backfillShopOrders = createServerFn({ method: "POST" }).handler(
  async () => {
    const pageSize = 500;
    let offset = 0;
    let scanned = 0;
    let updated = 0;
    while (true) {
      const { data, error } = await supabase
        .from("youzan_orders")
        .select("id, status, raw")
        .range(offset, offset + pageSize - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      scanned += data.length;
      for (const row of data) {
        const raw = (row as { raw: unknown }).raw;
        if (!raw || typeof raw !== "object") continue;
        const status = (row as { status: string | null }).status ?? null;
        const enriched = enrichOrderFields(raw as Record<string, unknown>, status);
        const patch: Record<string, unknown> = {
          buyer_open_id: enriched.buyer_open_id,
          item_count: enriched.item_count,
          sku_count: enriched.sku_count,
          item_titles: enriched.item_titles,
          first_item_image: enriched.first_item_image,
          receiver_name: enriched.receiver_name,
          receiver_tel: enriched.receiver_tel,
          receiver_address: enriched.receiver_address,
          outer_transaction_no: enriched.outer_transaction_no,
          post_fee: enriched.post_fee,
          status_text: enriched.status_text,
        };
        if (enriched.buyer_nick) patch.buyer_nick = enriched.buyer_nick;
        if (enriched.item_count && enriched.item_count > 0) patch.num = enriched.item_count;
        const { error: upErr } = await supabase
          .from("youzan_orders")
          .update(patch as never)
          .eq("id", (row as { id: string }).id);
        if (!upErr) updated += 1;
      }
      if (data.length < pageSize) break;
      offset += pageSize;
      if (offset > 50000) break;
    }
    return { scanned, updated };
  },
);



