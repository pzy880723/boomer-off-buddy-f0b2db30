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
  // 有赞自用型应用换 token 的正确参数（官方文档 doc/7515）
  const res = await fetch(YZ_OAUTH_URL, {
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
    throw new Error(`有赞换 token 失败：${msg}`);
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
    success?: boolean;
    code?: number;
    message?: string;
    data?: unknown;
  };
  if (j.error_response) {
    const e = j.error_response;
    throw new Error(`[${e.code}] ${e.msg ?? ""} ${e.sub_msg ?? ""}`.trim());
  }
  if (j.success === false || (typeof j.code === "number" && j.code !== 0)) {
    throw new Error(`[${j.code ?? "?"}] ${j.message ?? "调用失败"}`);
  }
  return j.response ?? j.data ?? json;
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
          params: { page_no: 1, page_size: 200 },
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

        const { error } = await supabase.from("youzan_shops").insert({
          kdt_id: s.kdt_id,
          shop_name: s.shop_name,
          role: "branch",
          parent_kdt_id: s.parent_kdt_id ?? null,
          status: "active",
          access_token: t.access_token,
          refresh_token: t.refresh_token,
          token_expires_at: t.token_expires_at,
          authorized_at: new Date().toISOString(),
        } as never);
        if (error) throw new Error(error.message);
        added += 1;
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
// 内部：单店商品同步逻辑（被 syncYouzanItems / syncAllShops 复用）
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

  try {
    const token = await ensureAccessToken(shop);
    const pageSize = 100;
    const seen = new Set<number>();
    let totalUpserted = 0;

    for (const m of [
      { method: "youzan.items.onsale.get", version: "3.0.0", listed: true },
      { method: "youzan.items.inventory.get", version: "3.0.0", listed: false },
    ]) {
      let page = 1;
      for (;;) {
        const raw = (await callYouzanApi({
          accessToken: token,
          method: m.method,
          version: m.version,
          params: { page_no: page, page_size: pageSize },
        })) as {
          items?: Array<Record<string, unknown>>;
          total_results?: number;
        };
        const items = raw.items ?? [];
        if (items.length === 0) break;

        const rows = items
          .map((it) => {
            const itemId = Number(it.item_id ?? it.num_iid ?? 0);
            if (!itemId || seen.has(itemId)) return null;
            seen.add(itemId);
            return {
              shop_id: shop.id,
              kdt_id: shop.kdt_id,
              item_id: itemId,
              title: String(it.title ?? ""),
              price: Number(it.price ?? 0) || 0,
              stock_qty: Number(it.num ?? it.quantity ?? 0) || 0,
              is_listed: m.listed,
              pic_url:
                (it.pic_url as string) ??
                (it.pic_thumb_url as string) ??
                (Array.isArray(it.pic_urls) ? (it.pic_urls[0] as string) : null) ??
                null,
              raw: it,
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);

        if (rows.length > 0) {
          const { error } = await supabase
            .from("youzan_items")
            .upsert(rows as never, { onConflict: "kdt_id,item_id" });
          if (error) throw new Error(error.message);
          totalUpserted += rows.length;
        }
        if (items.length < pageSize) break;
        page += 1;
        if (page > 200) break;
      }
    }

    const msg = `同步商品 ${totalUpserted} 条`;
    if (log?.id) {
      await supabase
        .from("youzan_sync_logs")
        .update({
          status: "ok",
          count_in: totalUpserted,
          message: msg,
          finished_at: new Date().toISOString(),
        } as never)
        .eq("id", log.id);
    }
    return { ok: true, count: totalUpserted, message: msg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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
    return { ok: false, count: 0, message: msg };
  }
}

export const syncYouzanItems = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ shop_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const shop = await getShopOr404({ shop_id: data.shop_id });
    return runItemsSyncForShop(shop);
  });

// ============================================================
// 内部：单店订单同步（被 syncYouzanOrders / syncAllShops 复用）
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

  try {
    const token = await ensureAccessToken(shop);
    const pageSize = 100;
    let page = 1;
    let totalUpserted = 0;

    for (;;) {
      const raw = (await callYouzanApi({
        accessToken: token,
        method: "youzan.trades.sold.get",
        version: "4.0.0",
        params: {
          start_update: fmt(startDate),
          end_update: fmt(endDate),
          page_no: page,
          page_size: pageSize,
        },
      })) as {
        trades?: Array<Record<string, unknown>>;
        full_trades?: { trades?: Array<Record<string, unknown>> };
        total_results?: number;
      };
      const trades = raw.trades ?? raw.full_trades?.trades ?? [];
      if (trades.length === 0) break;

      const rows = trades
        .map((t) => {
          const tid = String(t.tid ?? "");
          if (!tid) return null;
          const payTime = t.pay_time ? String(t.pay_time) : null;
          const created = t.created ? String(t.created) : null;
          return {
            shop_id: shop.id,
            kdt_id: shop.kdt_id,
            tid,
            status: (t.status as string) ?? null,
            buyer_nick: (t.buyer_nick as string) ?? null,
            payment: Number(t.payment ?? 0) || 0,
            total_fee: Number(t.total_fee ?? 0) || 0,
            num: Number(t.num ?? 0) || 0,
            pay_type:
              typeof t.pay_type === "number"
                ? t.pay_type
                : t.pay_type
                  ? Number(t.pay_type)
                  : null,
            pay_time: payTime ? new Date(payTime).toISOString() : null,
            created_time: created ? new Date(created).toISOString() : null,
            raw: t,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      if (rows.length > 0) {
        const { error } = await supabase
          .from("youzan_orders")
          .upsert(rows as never, { onConflict: "kdt_id,tid" });
        if (error) throw new Error(error.message);
        totalUpserted += rows.length;
      }
      if (trades.length < pageSize) break;
      page += 1;
      if (page > 500) break;
    }

    const msg = `同步订单 ${totalUpserted} 条（${fmt(startDate)} ~ ${fmt(endDate)}）`;
    if (log?.id) {
      await supabase
        .from("youzan_sync_logs")
        .update({
          status: "ok",
          count_in: totalUpserted,
          message: msg,
          finished_at: new Date().toISOString(),
        } as never)
        .eq("id", log.id);
    }
    return { ok: true, count: totalUpserted, message: msg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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
    return { ok: false, count: 0, message: msg };
  }
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
    const shop = await getShopOr404({ shop_id: data.shop_id });
    const endDate = data.end ? new Date(data.end) : new Date();
    const startDate = data.start
      ? new Date(data.start)
      : new Date(Date.now() - 30 * 86_400_000);
    return runOrdersSyncForShop(shop, startDate, endDate);
  });

// ============================================================
// syncAllShops — 一键同步全部门店（商品 + 近 N 天订单）
// ============================================================
export const syncAllShops = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({ days: z.number().int().min(1).max(180).default(30) })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const { data: shopsRaw, error } = await supabase
      .from("youzan_shops")
      .select("*")
      .eq("status", "active");
    if (error) throw new Error(error.message);
    const shops = (shopsRaw ?? []) as ShopRow[];

    const endDate = new Date();
    const startDate = new Date(Date.now() - data.days * 86_400_000);

    const results: Array<{
      shop_id: string;
      kdt_id: number;
      shop_name: string;
      items: { ok: boolean; count: number; message: string };
      orders: { ok: boolean; count: number; message: string };
    }> = [];

    for (const shop of shops) {
      const items = await runItemsSyncForShop(shop);
      const orders = await runOrdersSyncForShop(shop, startDate, endDate);
      results.push({
        shop_id: shop.id,
        kdt_id: shop.kdt_id,
        shop_name: shop.shop_name,
        items,
        orders,
      });
    }

    const itemsTotal = results.reduce((s, r) => s + r.items.count, 0);
    const ordersTotal = results.reduce((s, r) => s + r.orders.count, 0);
    const okCount = results.filter((r) => r.items.ok && r.orders.ok).length;
    const failCount = results.length - okCount;

    return {
      shopCount: results.length,
      okCount,
      failCount,
      itemsTotal,
      ordersTotal,
      results,
    };
  });

