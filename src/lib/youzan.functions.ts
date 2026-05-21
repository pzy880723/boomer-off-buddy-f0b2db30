import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

// ============================================================
// 有赞自用型应用 OAuth：grant_type=silent + kdt_id
// 文档：https://doc.youzanyun.com/detail/API/0/906
// ============================================================
const YZ_OAUTH_URL = "https://open.youzanyun.com/auth/token";
const YZ_GW_URL = "https://open.youzanyun.com/api/oauthentry";

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
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "silent",
    kdt_id: String(kdtId),
  });
  const res = await fetch(YZ_OAUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    expires?: number;
    error?: string;
    error_response?: { code?: number; msg?: string };
  };
  if (!res.ok || !json.access_token) {
    const msg =
      json.error_response?.msg ||
      json.error ||
      `HTTP ${res.status} ${JSON.stringify(json)}`;
    throw new Error(`有赞换 token 失败：${msg}`);
  }
  const expiresInSec = json.expires_in ?? 7 * 24 * 3600;
  const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? null,
    token_expires_at: expiresAt,
  };
}

/**
 * 拿一家店的 access_token：有缓存且未过期则直接用，
 * 否则向有赞重新换并写回 youzan_shops。
 */
async function ensureAccessToken(shop: ShopRow): Promise<string> {
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
  const url = `${YZ_GW_URL}/${opts.method}/${opts.version}?access_token=${encodeURIComponent(opts.accessToken)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts.params ?? {}),
  });
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
  };
  if (j.error_response) {
    const e = j.error_response;
    throw new Error(`[${e.code}] ${e.msg ?? ""} ${e.sub_msg ?? ""}`.trim());
  }
  return j.response ?? json;
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
