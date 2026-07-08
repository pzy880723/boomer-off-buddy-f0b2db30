import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import { getYouzanOutboundStatus, youzanFetch } from "./youzan-http";

// ============================================================
// 库存调拨 ServerFn
// ------------------------------------------------------------
// 4 种调拨类型：
//   wh_to_shop   仓库 -> 有赞门店（一件同步）
//   shop_to_shop 有赞门店 A -> 有赞门店 B
//   shop_to_wh   有赞门店 -> 仓库（退仓）
//   consume      门店或仓库销售/损耗出库（不进入任何渠道）
// ============================================================

const YZ_OAUTH_URL = "https://open.youzanyun.com/auth/token";
const YZ_GW_URL = "https://open.youzanyun.com/api";

function formatYouzanIpError(message: string) {
  if (/gw\s*4007|IP\s*.*white|whitelist|白名单|源\s*IP\s*地址/i.test(message)) {
    const outbound = getYouzanOutboundStatus();
    if (outbound.mode === "fixed_proxy") {
      return `${message}。当前已启用固定出口代理，请确认有赞白名单配置的是固定代理出口 IP${outbound.outbound_ip ? `：${outbound.outbound_ip}` : ""}。`;
    }
    return `${message}。当前仍是直连动态出口，发布后也不保证 IP 固定；请配置 YOUZAN_PROXY_URL 固定出口代理。`;
  }
  return message;
}

type ShopRow = {
  id: string;
  kdt_id: number;
  shop_name: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
};

async function fetchSilentToken(kdtId: number) {
  const clientId = process.env.YOUZAN_CLIENT_ID;
  const clientSecret = process.env.YOUZAN_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("YOUZAN_CLIENT_ID / SECRET 未配置");
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
    code?: number;
    message?: string;
    data?: { access_token?: string; refresh_token?: string; expires_in?: number; expires?: number } | null;
  } = {};
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`有赞响应非 JSON：${text.slice(0, 200)}`);
  }
  const access_token = json.access_token ?? json.data?.access_token;
  if (!access_token) throw new Error(formatYouzanIpError(`有赞换 token 失败：${json.message ?? text.slice(0, 200)}`));
  const expiresTs = json.expires ?? json.data?.expires;
  const expiresIn = json.expires_in ?? json.data?.expires_in;
  const expiresAt =
    expiresTs && expiresTs > 1_000_000_000_000
      ? new Date(expiresTs).toISOString()
      : expiresIn
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : new Date(Date.now() + 7 * 86_400_000).toISOString();
  return { access_token, refresh_token: json.refresh_token ?? json.data?.refresh_token ?? null, token_expires_at: expiresAt };
}

async function ensureAccessToken(shop: ShopRow): Promise<string> {
  const expAt = shop.token_expires_at ? new Date(shop.token_expires_at).getTime() : 0;
  if (shop.access_token && expAt - Date.now() > 5 * 60 * 1000) return shop.access_token;
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

async function callYouzanApi(opts: {
  accessToken: string;
  method: string;
  version: string;
  params?: Record<string, unknown>;
}): Promise<unknown> {
  const url = `${YZ_GW_URL}/${opts.method}/${opts.version}?access_token=${encodeURIComponent(opts.accessToken)}`;
  const res = await youzanFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts.params ?? {}),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`有赞响应非 JSON：${text.slice(0, 200)}`);
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
    throw new Error(formatYouzanIpError(`[${j.error_response.code}] ${j.error_response.msg ?? ""} ${j.error_response.sub_msg ?? ""}`.trim()));
  }
  if (j.success === false || (typeof j.code === "number" && j.code !== 0)) {
    throw new Error(formatYouzanIpError(`[${j.code ?? "?"}] ${j.message ?? "调用失败"}`));
  }
  return j.response ?? j.data ?? json;
}

async function getShop(id: string): Promise<ShopRow> {
  const { data, error } = await supabase.from("youzan_shops").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("门店不存在");
  return data as ShopRow;
}

/**
 * 改有赞门店销售库存（增量适配器）
 * ------------------------------------------------------------
 * 2026-07 audit：quantity.update/4.0.0 只支持"全量覆盖"，无 type=1/2 增量语义。
 * 老 stock-transfer 走 delta 语义，这里做适配：
 *   1) 从本地 youzan_items 拿当前 stock_qty
 *   2) new = max(0, current + delta)
 *   3) 用【分店 token】+ 分店 kdt_id + item_id + sku_id + stock_num_str=String(new)
 * 注意：itemId 必须是【分店 storefront 侧真实 item_id】（来自 youzan_items 拉取），
 * 不是 HQ SPU id；否则 [301000002] 商品ID缺失。多 SKU 商品目前默认 sku_id=item_id，
 * 若涉及规格商品，请改走 sync_stock 主链路（pushStockToYouzan + resolveBranchItemIds）。
 */
async function pushYouzanQuantityDelta(shop: ShopRow, itemId: number, delta: number) {
  if (delta === 0) return;
  if ((shop as { role?: string }).role !== "branch") {
    throw new Error("quantity.update 只允许推分店（branch）库存");
  }
  const token = await ensureAccessToken(shop);

  // 读当前库存（本地缓存）
  const { data: cur } = await supabase
    .from("youzan_items")
    .select("stock_qty")
    .eq("shop_id", (shop as { id: string }).id)
    .eq("item_id", itemId)
    .maybeSingle();
  const currentStock = Number((cur as { stock_qty?: number } | null)?.stock_qty ?? 0);
  const nextStock = Math.max(0, currentStock + delta);

  await callYouzanApi({
    accessToken: token,
    method: "youzan.item.quantity.update",
    version: "4.0.0",
    params: {
      kdt_id: (shop as { kdt_id: number }).kdt_id,
      item_id: itemId,
      sku_id: itemId, // 无规格商品 sku_id 传 item_id/spu_id（有规格请走主链路）
      channel: 1,
      stock_num_str: String(nextStock),
    },
  });
}


// ============================================================
// listShopProducts — 门店商品库统一查询
// ============================================================
export const listShopProducts = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z
      .object({
        shop_id: z.string().uuid().optional(),
        search: z.string().optional(),
        listed: z.boolean().optional(),
        limit: z.number().min(1).max(2000).default(1000),
        low_stock_threshold: z.number().min(0).default(3),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const { data: shops } = await supabase
      .from("youzan_shops")
      .select("id, shop_name, kdt_id, role")
      .order("role", { ascending: true });
    const shopList = shops ?? [];
    const shopById = new Map(shopList.map((s) => [s.id as string, s]));

    let q = supabase
      .from("youzan_items")
      .select(
        "id, shop_id, kdt_id, item_id, title, price, stock_qty, is_listed, pic_url, updated_at",
      )
      .order("updated_at", { ascending: false })
      .limit(data.limit);
    if (data.search) {
      const s = `%${data.search}%`;
      q = q.or(`title.ilike.${s}`);
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const allRows = (rows ?? []) as Array<{
      id: string;
      shop_id: string;
      kdt_id: number;
      item_id: number;
      title: string | null;
      price: number | null;
      stock_qty: number;
      is_listed: boolean;
      pic_url: string | null;
      updated_at: string;
    }>;

    // 按 item_id 聚合：同一 SPU 在不同门店各占一行，合并成一条
    const groups = new Map<number, typeof allRows>();
    for (const r of allRows) {
      const arr = groups.get(r.item_id) ?? [];
      arr.push(r);
      groups.set(r.item_id, arr);
    }

    const items = Array.from(groups.values()).map((rows) => {
      // 选首选展示行（HQ 优先；否则最新一条）
      const sorted = [...rows].sort((a, b) => {
        const ra = shopById.get(a.shop_id)?.role === "hq" ? 0 : 1;
        const rb = shopById.get(b.shop_id)?.role === "hq" ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
      });
      const primary = sorted[0];
      const totalStock = rows.reduce((s, r) => s + (r.stock_qty || 0), 0);
      const onSaleShops = rows
        .filter((r) => r.is_listed && (r.stock_qty || 0) > 0)
        .map((r) => {
          const sh = shopById.get(r.shop_id);
          return {
            shop_id: r.shop_id,
            shop_name: sh?.shop_name ?? String(r.kdt_id),
            role: sh?.role ?? "branch",
            stock_qty: r.stock_qty || 0,
            low: (r.stock_qty || 0) <= data.low_stock_threshold,
          };
        });
      const anyListed = rows.some((r) => r.is_listed);
      // 状态：red 全部下架或库存=0；orange 在售但库存≤阈值；green 正常
      let status: "green" | "orange" | "red";
      if (!anyListed || totalStock === 0) status = "red";
      else if (totalStock <= data.low_stock_threshold) status = "orange";
      else status = "green";
      return {
        id: primary.id,
        item_id: primary.item_id,
        title: primary.title,
        pic_url: primary.pic_url,
        price: primary.price,
        total_stock: totalStock,
        is_listed: anyListed,
        status,
        on_sale_shops: onSaleShops,
        rows, // 全部分店明细，调拨弹窗用
      };
    });

    // 应用 shop_id / listed 过滤（在聚合层面）
    const filtered = items.filter((it) => {
      if (data.listed !== undefined && it.is_listed !== data.listed) return false;
      if (data.shop_id) {
        const has = it.rows.some((r) => r.shop_id === data.shop_id);
        if (!has) return false;
      }
      return true;
    });

    return { items: filtered, shops: shopList };
  });


// ============================================================
// listStockTransfers
// ============================================================
export const listStockTransfers = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z
      .object({
        kind: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().min(1).max(200).default(50),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    let q = supabase
      .from("stock_transfers")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.kind) q = q.eq("kind", data.kind);
    if (data.status) q = q.eq("status", data.status);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { transfers: rows ?? [] };
  });

// ============================================================
// createTransfer — 核心：调拨 + 立即同步有赞
// ============================================================
const TransferInput = z.object({
  kind: z.enum(["wh_to_shop", "shop_to_shop", "shop_to_wh", "consume"]),
  from_shop_id: z.string().uuid().nullable().optional(),
  to_shop_id: z.string().uuid().nullable().optional(),
  from_sku_id: z.string().uuid().nullable().optional(),
  to_sku_id: z.string().uuid().nullable().optional(),
  from_youzan_item_id: z.number().int().positive().nullable().optional(),
  to_youzan_item_id: z.number().int().positive().nullable().optional(),
  qty: z.number().int().positive(),
  reason: z.string().nullable().optional(),
  operator: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const createTransfer = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => TransferInput.parse(input))
  .handler(async ({ data }) => {
    // 1. 校验参数组合
    const { kind, qty } = data;
    if (kind === "wh_to_shop") {
      if (!data.from_sku_id || !data.to_shop_id || !data.to_youzan_item_id)
        throw new Error("仓库→门店 需要 from_sku_id / to_shop_id / to_youzan_item_id");
    } else if (kind === "shop_to_shop") {
      if (!data.from_shop_id || !data.from_youzan_item_id || !data.to_shop_id || !data.to_youzan_item_id)
        throw new Error("门店→门店 需要源/目标店及双方 item_id");
    } else if (kind === "shop_to_wh") {
      if (!data.from_shop_id || !data.from_youzan_item_id || !data.to_sku_id)
        throw new Error("门店→仓库 需要 from_shop_id / from_youzan_item_id / to_sku_id");
    } else if (kind === "consume") {
      if (!data.from_shop_id && !data.from_sku_id)
        throw new Error("销售/损耗 需要源（门店或仓库 SKU）");
      if (data.from_shop_id && !data.from_youzan_item_id)
        throw new Error("门店出库需要 from_youzan_item_id");
    }

    // 2. 库存校验（仓库侧）
    if (data.from_sku_id) {
      const { data: sku } = await supabase
        .from("inv_skus")
        .select("stock_qty, name")
        .eq("id", data.from_sku_id)
        .maybeSingle();
      if (!sku) throw new Error("仓库 SKU 不存在");
      if ((sku.stock_qty ?? 0) < qty) throw new Error(`仓库库存不足：${sku.name} 仅 ${sku.stock_qty} 件`);
    }

    // 3. 调用有赞接口
    let syncStatus: "ok" | "partial" | "failed" | "not_required" = "not_required";
    let syncError: string | null = null;
    let rollback: (() => Promise<void>) | null = null;

    try {
      if (kind === "wh_to_shop") {
        const toShop = await getShop(data.to_shop_id!);
        await pushYouzanQuantityDelta(toShop, data.to_youzan_item_id!, +qty);
        syncStatus = "ok";
      } else if (kind === "shop_to_shop") {
        const fromShop = await getShop(data.from_shop_id!);
        const toShop = await getShop(data.to_shop_id!);
        await pushYouzanQuantityDelta(fromShop, data.from_youzan_item_id!, -qty);
        rollback = async () => {
          try {
            await pushYouzanQuantityDelta(fromShop, data.from_youzan_item_id!, +qty);
          } catch {
            /* swallow rollback failure, will be reported */
          }
        };
        await pushYouzanQuantityDelta(toShop, data.to_youzan_item_id!, +qty);
        rollback = null;
        syncStatus = "ok";
      } else if (kind === "shop_to_wh") {
        const fromShop = await getShop(data.from_shop_id!);
        await pushYouzanQuantityDelta(fromShop, data.from_youzan_item_id!, -qty);
        syncStatus = "ok";
      } else if (kind === "consume") {
        if (data.from_shop_id) {
          const fromShop = await getShop(data.from_shop_id);
          await pushYouzanQuantityDelta(fromShop, data.from_youzan_item_id!, -qty);
          syncStatus = "ok";
        } else {
          syncStatus = "not_required"; // 仅仓库扣减
        }
      }
    } catch (e) {
      syncError = e instanceof Error ? e.message : String(e);
      syncStatus = "failed";
      if (rollback) {
        try {
          await rollback();
          syncError += "（已回滚源店）";
        } catch {
          syncError += "（回滚失败！请人工核对源店库存）";
          syncStatus = "partial";
        }
      }
      // 失败仍写一条 failed 单，方便重试与排查
    }

    // 4. 生成单号
    const { data: codeData, error: codeErr } = await supabase.rpc("gen_stock_transfer_code");
    if (codeErr) throw new Error(codeErr.message);
    const code = codeData as unknown as string;

    // 5. 写调拨单
    const status = syncStatus === "failed" || syncStatus === "partial" ? "failed" : "posted";
    const { data: row, error: insErr } = await supabase
      .from("stock_transfers")
      .insert({
        code,
        kind,
        status,
        from_shop_id: data.from_shop_id ?? null,
        to_shop_id: data.to_shop_id ?? null,
        from_sku_id: data.from_sku_id ?? null,
        to_sku_id: data.to_sku_id ?? null,
        from_youzan_item_id: data.from_youzan_item_id ?? null,
        to_youzan_item_id: data.to_youzan_item_id ?? null,
        qty,
        reason: data.reason ?? null,
        operator: data.operator ?? null,
        notes: data.notes ?? null,
        youzan_sync_status: syncStatus,
        youzan_error_msg: syncError,
        posted_at: status === "posted" ? new Date().toISOString() : null,
      } as never)
      .select("*")
      .single();
    if (insErr) throw new Error(insErr.message);

    // 6. 同步更新本地库存缓存（仅 posted 单）
    if (status === "posted") {
      // 仓库 SKU 增减
      if (data.from_sku_id) {
        await supabase.rpc("inv_apply_stock_delta", { p_sku_id: data.from_sku_id, p_delta: -qty });
      }
      if (data.to_sku_id) {
        await supabase.rpc("inv_apply_stock_delta", { p_sku_id: data.to_sku_id, p_delta: +qty });
      }
      // 推送到有赞（已绑定才推；未绑定自动忽略）
      try {
        const { enqueueStockPush } = await import("./youzan-sync.functions");
        if (data.from_sku_id) await enqueueStockPush(data.from_sku_id, "transfer");
        if (data.to_sku_id) await enqueueStockPush(data.to_sku_id, "transfer");
      } catch {
        // 不阻塞调拨
      }

      // 有赞 items 本地缓存
      const updates: Array<{ shop_id: string; item_id: number; delta: number }> = [];
      if (kind === "wh_to_shop")
        updates.push({ shop_id: data.to_shop_id!, item_id: data.to_youzan_item_id!, delta: +qty });
      if (kind === "shop_to_shop") {
        updates.push({ shop_id: data.from_shop_id!, item_id: data.from_youzan_item_id!, delta: -qty });
        updates.push({ shop_id: data.to_shop_id!, item_id: data.to_youzan_item_id!, delta: +qty });
      }
      if (kind === "shop_to_wh")
        updates.push({ shop_id: data.from_shop_id!, item_id: data.from_youzan_item_id!, delta: -qty });
      if (kind === "consume" && data.from_shop_id)
        updates.push({ shop_id: data.from_shop_id, item_id: data.from_youzan_item_id!, delta: -qty });

      for (const u of updates) {
        const { data: cur } = await supabase
          .from("youzan_items")
          .select("id, stock_qty")
          .eq("shop_id", u.shop_id)
          .eq("item_id", u.item_id)
          .maybeSingle();
        if (cur) {
          await supabase
            .from("youzan_items")
            .update({ stock_qty: Math.max(0, (cur.stock_qty ?? 0) + u.delta) } as never)
            .eq("id", cur.id);
        }
      }
    }

    return {
      ok: status === "posted",
      transfer: row,
      message:
        status === "posted"
          ? `调拨成功：${code}`
          : `调拨失败：${syncError ?? "未知错误"}`,
    };
  });
