import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  callYouzanApiVerbose,
  ensureAccessToken,
  getHqShop,
} from "./youzan.functions";

// 内部：按 shop_id 加载店铺（HQ 或分店都可）
async function getShopById(shopId: string) {
  const { data, error } = await supabase
    .from("youzan_shops")
    .select("*")
    .eq("id", shopId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`youzan_shop ${shopId} 不存在`);
  return data as unknown as Parameters<typeof ensureAccessToken>[0] & {
    id: string;
    kdt_id: number;
    role: "hq" | "branch";
    shop_name: string;
  };
}

// ============================================================
// 类型
// ============================================================
export type LinkRow = {
  id: string;
  sku_id: string;
  shop_id: string;
  yz_item_id: number;
  yz_sku_id: number | null;
  last_pushed_stock: number | null;
  last_pushed_at: string | null;
  last_pull_stock: number | null;
  last_pull_at: string | null;
  status: "linked" | "mismatch" | "error";
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

// ============================================================
// 内部：覆盖式推送分店库存
// ------------------------------------------------------------
// 连锁零售正确姿势：用【总部 token】+ youzan.retail.open.stock.adjust/3.0.0
// - kdt_id = 分店 kdt_id（目标）
// - spu_id = 总部 HQ SPU id（从 sku_youzan_links role=hq_spu 拿）
// - outer_sku_id = 本地 sku_code（有赞 SKU 用 outer_sku_id 定位最稳）
// - adjust_num = 目标绝对值；type=set 覆盖
// 老的 item.quantity.update / retail.open.stock.update 对连锁分店会报
// "不允许更新供货模式的商品库存" / "只有门店或独立仓可以操作"，一律弃用。
// ============================================================
async function pushStockToYouzan(
  link: LinkRow,
  targetStock: number,
  clientSeq: string,
): Promise<void> {
  const branchShop = await getShopById(link.shop_id);
  const num = Math.max(0, targetStock);

  // 拿总部 SPU id
  const { data: hqLink } = await supabase
    .from("sku_youzan_links")
    .select("yz_item_id")
    .eq("sku_id", link.sku_id)
    .eq("role", "hq_spu")
    .maybeSingle();
  const hqSpuId = Number(hqLink?.yz_item_id ?? 0);

  // 拿 outer_sku_id（本地 sku_code）
  const { data: sku } = await supabase
    .from("inv_skus")
    .select("sku_code")
    .eq("id", link.sku_id)
    .maybeSingle();

  const hq = await getHqShop();
  const hqToken = await ensureAccessToken(hq);

  const params: Record<string, unknown> = {
    kdt_id: branchShop.kdt_id,
    adjust_num: num,
    type: "set",
    client_seq: clientSeq,
  };
  if (hqSpuId) params.spu_id = hqSpuId;
  if (link.yz_sku_id) params.sku_id = link.yz_sku_id;
  if (sku?.sku_code) params.outer_sku_id = sku.sku_code;

  await callYouzanApiVerbose({
    accessToken: hqToken,
    method: "youzan.retail.open.stock.adjust",
    version: "3.0.0",
    params,
    timeoutMs: 20_000,
  });
}

// ============================================================
// pushIsDisplayToYouzan —— 分店上下架（用 HQ token）
// ============================================================
async function pushIsDisplayToYouzan(
  link: LinkRow,
  isDisplay: boolean,
): Promise<void> {
  const branchShop = await getShopById(link.shop_id);
  const hq = await getHqShop();
  const hqToken = await ensureAccessToken(hq);
  const method = isDisplay
    ? "youzan.retail.open.product.online"
    : "youzan.retail.open.product.offline";
  await callYouzanApiVerbose({
    accessToken: hqToken,
    method,
    version: "1.0.0",
    params: { kdt_id: branchShop.kdt_id, item_id: link.yz_item_id },
    timeoutMs: 20_000,
  });
}

// ============================================================
// searchYouzanItems —— 「绑定弹窗」搜索有赞总部商品
// ============================================================
export const searchYouzanItems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        q: z.string().trim().max(200).optional(),
        limit: z.number().min(1).max(100).default(30),
        only_unbound: z.boolean().default(false),
        shop_id: z.string().uuid().optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    // shop_id 缺省时落到总部，兼容旧调用
    let shopId = data.shop_id ?? null;
    if (!shopId) {
      const { data: hq } = await supabase
        .from("youzan_shops")
        .select("id")
        .eq("role", "hq")
        .maybeSingle();
      if (!hq) return { rows: [] };
      shopId = hq.id;
    }

    let q = supabase
      .from("youzan_items")
      .select("id, item_id, title, price, stock_qty, is_listed, pic_url, updated_at")
      .eq("shop_id", shopId)
      .order("updated_at", { ascending: false })
      .limit(data.limit);

    if (data.q) {
      const kw = data.q.trim();
      const asNum = Number(kw);
      if (Number.isInteger(asNum) && asNum > 0) {
        q = q.or(`title.ilike.%${kw}%,item_id.eq.${asNum}`);
      } else {
        q = q.ilike("title", `%${kw}%`);
      }
    }

    const { data: items, error } = await q;
    if (error) throw new Error(error.message);

    // 标记已被占用（同店内同一 item 只能绑一个本地 SKU）
    const ids = (items ?? []).map((r) => r.item_id);
    let bound = new Map<number, string>();
    if (ids.length > 0) {
      const { data: links } = await supabase
        .from("sku_youzan_links")
        .select("yz_item_id, sku_id")
        .eq("shop_id", shopId)
        .in("yz_item_id", ids);
      bound = new Map((links ?? []).map((l) => [l.yz_item_id, l.sku_id]));
    }

    let rows = (items ?? []).map((r) => ({
      ...r,
      bound_sku_id: bound.get(r.item_id) ?? null,
    }));
    if (data.only_unbound) rows = rows.filter((r) => !r.bound_sku_id);
    return { rows };
  });

// ============================================================
// listYouzanItemsByShop —— 「门店商品库」分页浏览
// ============================================================
export const listYouzanItemsByShop = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        shop_id: z.string().uuid(),
        q: z.string().trim().max(200).optional(),
        limit: z.number().min(1).max(200).default(60),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    let q = supabase
      .from("youzan_items")
      .select(
        "id, item_id, title, price, stock_qty, is_listed, pic_url, updated_at",
      )
      .eq("shop_id", data.shop_id)
      .order("updated_at", { ascending: false })
      .limit(data.limit);
    if (data.q) {
      const kw = data.q.trim();
      const asNum = Number(kw);
      if (Number.isInteger(asNum) && asNum > 0) {
        q = q.or(`title.ilike.%${kw}%,item_id.eq.${asNum}`);
      } else {
        q = q.ilike("title", `%${kw}%`);
      }
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const ids = (rows ?? []).map((r) => r.item_id);
    let linkMap = new Map<number, { sku_id: string; sku_name: string }>();
    if (ids.length > 0) {
      const { data: links } = await supabase
        .from("sku_youzan_links")
        .select("yz_item_id, sku_id, inv_skus(name)")
        .eq("shop_id", data.shop_id)
        .in("yz_item_id", ids);
      linkMap = new Map(
        (links ?? []).map((l) => [
          l.yz_item_id,
          {
            sku_id: l.sku_id,
            sku_name:
              (l as unknown as { inv_skus?: { name?: string } }).inv_skus
                ?.name ?? "",
          },
        ]),
      );
    }

    return {
      rows: (rows ?? []).map((r) => ({
        ...r,
        link: linkMap.get(r.item_id) ?? null,
      })),
    };
  });

// ============================================================
// linkSkuToYouzanItem —— 把本地 SKU 与有赞商品绑定
// ============================================================
export const linkSkuToYouzanItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        sku_id: z.string().uuid(),
        yz_item_id: z.number().int().positive(),
        yz_sku_id: z.number().int().positive().optional(),
        shop_id: z.string().uuid().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    // shop_id 缺省回落总部
    let shopId = data.shop_id ?? null;
    if (!shopId) {
      const hq = await getHqShop();
      shopId = hq.id;
    }

    const { data: sku } = await supabase
      .from("inv_skus")
      .select("id, name, stock_qty")
      .eq("id", data.sku_id)
      .maybeSingle();
    if (!sku) throw new Error("本地 SKU 不存在");

    const { data: yzItem } = await supabase
      .from("youzan_items")
      .select("item_id, title")
      .eq("shop_id", shopId)
      .eq("item_id", data.yz_item_id)
      .maybeSingle();
    if (!yzItem) {
      throw new Error("该门店中找不到这个有赞商品，请先把该门店的商品同步到本地");
    }

    const { error: upErr } = await supabase
      .from("sku_youzan_links")
      .upsert(
        {
          sku_id: data.sku_id,
          shop_id: shopId,
          yz_item_id: data.yz_item_id,
          yz_sku_id: data.yz_sku_id ?? null,
          status: "linked",
          last_error: null,
        } as never,
        { onConflict: "sku_id,shop_id" },
      );
    if (upErr) throw new Error(upErr.message);

    // 立即触发一次以本地库存为准的推送（按 sku 维度即可）
    await enqueueAndRun(data.sku_id, "link_init");

    return {
      ok: true,
      message: `已绑定「${yzItem.title}」，并按本地库存 ${sku.stock_qty} 同步`,
    };
  });

// ============================================================
// unlinkSku —— 解绑（可指定门店；不传则全解）
// ============================================================
export const unlinkSku = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        sku_id: z.string().uuid(),
        shop_id: z.string().uuid().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    let q = supabase
      .from("sku_youzan_links")
      .delete()
      .eq("sku_id", data.sku_id);
    if (data.shop_id) q = q.eq("shop_id", data.shop_id);
    const { error } = await q;
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ============================================================
// pushSkuAsNewYouzanItem —— 应急：本地 → 有赞建商品
// ------------------------------------------------------------
// 仅提供一个最小可用的封装；零售连锁版 spu.add 实际所需的类目 / 规格
// 字段较多，建议用户后续按需扩展。
// ============================================================
async function resolveHqCategoryId(sku: {
  category?: string | null;
}): Promise<number> {
  // 优先 inv_categories.youzan_hq_category_id
  if (sku.category) {
    const { data: cat } = await supabase
      .from("inv_categories")
      .select("youzan_hq_category_id")
      .eq("code", sku.category)
      .maybeSingle();
    const id = Number((cat as { youzan_hq_category_id?: number | null } | null)?.youzan_hq_category_id ?? 0);
    if (id > 0) return id;
  }
  // 兜底 app_settings.youzan_hq_default_category_id
  const { data: setting } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "youzan_hq_default_category_id")
    .maybeSingle();
  const rawValue = (setting as { value?: unknown } | null)?.value;
  const fallbackId = Number(
    typeof rawValue === "number"
      ? rawValue
      : (rawValue as { id?: number } | null)?.id ?? 0,
  );
  if (fallbackId > 0) return fallbackId;
  throw new Error(
    `SKU 类目「${sku.category ?? "未设置"}」尚未绑定有赞总部商品分组。请在「设置 → 商品分类」页把该类目关联到一个总部商品分组，或在「设置」里配置默认分组 id。`,
  );
}

/**
 * 按 sku_scope 汇总本次 spu.create / spu.update 要传的 sell_channel_ids。
 *  - standard：全部启用中的分店 kdt_id（无论是否已绑定）
 *  - custom：只包含已绑定的分店 + 本次追加的分店
 */
async function collectSellChannelKdtIds(
  sku_id: string,
  scope: "standard" | "custom",
  addShopId?: string,
): Promise<{ shopIds: string[]; kdtIds: number[] }> {
  if (scope === "standard") {
    const { data: shops } = await supabase
      .from("youzan_shops")
      .select("id, kdt_id, role, status")
      .eq("role", "branch");
    const active = (shops ?? []).filter(
      (s) => (s as { status?: string }).status !== "disabled",
    );
    return {
      shopIds: active.map((s) => s.id as string),
      kdtIds: active.map((s) => Number(s.kdt_id)),
    };
  }

  // custom：仅相关分店
  const { data: links } = await supabase
    .from("sku_youzan_links")
    .select("shop_id, role")
    .eq("sku_id", sku_id);
  const branchShopIds = new Set<string>();
  for (const l of links ?? []) {
    if ((l as { role?: string }).role === "branch_stock") {
      branchShopIds.add(l.shop_id as string);
    }
  }
  if (addShopId) branchShopIds.add(addShopId);
  const shopIds = Array.from(branchShopIds);
  if (shopIds.length === 0) return { shopIds, kdtIds: [] };
  const { data: shops } = await supabase
    .from("youzan_shops")
    .select("id, kdt_id, role")
    .in("id", shopIds);
  const kdtIds = (shops ?? [])
    .filter((s) => (s as { role?: string }).role === "branch")
    .map((s) => Number(s.kdt_id));
  return { shopIds, kdtIds };
}


/**
 * 组装 retail.open.spu.create.3.0.0 的 SKU 数组。
 * 单品：一条 sku；组包：先按最小可用信息给一条。
 */
function buildSpuSkuArray(sku: {
  id: string;
  sku_code: string;
  name: string;
  price_tier: string | number;
  weight_g?: number | null;
}): Array<Record<string, unknown>> {
  const priceCents = Math.round(Number(sku.price_tier) * 100);
  const item: Record<string, unknown> = {
    outer_sku_id: sku.sku_code,
    price: priceCents,
    stock_num: 0,
  };
  if (sku.weight_g && Number(sku.weight_g) > 0) item.weight = Number(sku.weight_g);
  return [item];
}

/**
 * ensureHqSpuLink —— 保证本地 SKU 在总部有一条 SPU
 * ------------------------------------------------------------
 * v3 版本改动：
 *  - 用【总部 token】调 youzan.retail.open.spu.create.3.0.0
 *  - 必传 offline_create=true（否则只建 SPU 不上架销售）
 *  - 若给了 branch 参数，把该分店 kdt_id 放进 sell_channel_ids（连锁"分店独占"= 只勾这家）
 *  - 返回的 spu_id 存到 sku_youzan_links (role=hq_spu, shop_id=HQ.id)
 */
export async function ensureHqSpuLink(
  sku_id: string,
  addBranchShopId?: string,
): Promise<{ created: boolean; yz_item_id: number; shop_id: string }> {
  const hq = await getHqShop();
  // 已有 HQ 绑定则直接返回（不改 sell_channel_ids）
  const { data: existed } = await supabase
    .from("sku_youzan_links")
    .select("yz_item_id")
    .eq("sku_id", sku_id)
    .eq("shop_id", hq.id)
    .maybeSingle();
  if (existed?.yz_item_id && Number(existed.yz_item_id) > 0) {
    return {
      created: false,
      yz_item_id: Number(existed.yz_item_id),
      shop_id: hq.id,
    };
  }

  const { data: sku } = await supabase
    .from("inv_skus")
    .select("id, sku_code, name, category, price_tier, image_url, weight_g, notes, sku_scope")
    .eq("id", sku_id)
    .maybeSingle();
  if (!sku) throw new Error("SKU 不存在");
  if (!sku.sku_code) throw new Error("SKU 缺少 sku_code，无法登记到有赞");

  const scope: "standard" | "custom" =
    ((sku as { sku_scope?: string }).sku_scope === "custom" ? "custom" : "standard");
  const categoryId = await resolveHqCategoryId(sku as { category?: string | null });
  const { kdtIds } = await collectSellChannelKdtIds(sku_id, scope, addBranchShopId);


  const params: Record<string, unknown> = {
    title: sku.name,
    outer_id: sku.sku_code,
    category_id: categoryId,
    offline_create: true,
    sku: buildSpuSkuArray(sku as { id: string; sku_code: string; name: string; price_tier: number | string; weight_g?: number | null }),
    images: sku.image_url ? [sku.image_url] : [],
  };
  if (kdtIds.length > 0) params.sell_channel_ids = kdtIds;
  if (sku.notes) params.desc = sku.notes;

  const token = await ensureAccessToken(hq);
  const res = await callYouzanApiVerbose({
    accessToken: token,
    method: "youzan.retail.open.spu.create",
    version: "3.0.0",
    params,
    timeoutMs: 30_000,
  });
  const payload = res.payload as Record<string, unknown>;
  const nested = (payload.data ?? payload) as Record<string, unknown>;
  const newSpuId = Number(
    nested.spu_id ?? nested.item_id ?? nested.id ?? payload.spu_id ?? payload.item_id ?? 0,
  );
  if (!newSpuId) {
    throw new Error(`spu.create 未返回 spu_id：${res.preview.slice(0, 200)}`);
  }

  await supabase.from("sku_youzan_links").upsert(
    {
      sku_id,
      shop_id: hq.id,
      yz_item_id: newSpuId,
      status: "linked",
      role: "hq_spu",
      sync_stock: false,
      last_error: null,
    } as never,
    { onConflict: "sku_id,shop_id" },
  );
  return { created: true, yz_item_id: newSpuId, shop_id: hq.id };
}

/**
 * 把某分店追加到已存在的 HQ SPU 的 sell_channel_ids。
 * 用 youzan.retail.open.spu.update.3.0.0，spu_id + 全量 sell_channel_ids。
 */
async function addBranchToHqSpu(sku_id: string, hqSpuId: number, addBranchShopId: string): Promise<void> {
  const hq = await getHqShop();
  const { kdtIds } = await collectSellChannelKdtIds(sku_id, addBranchShopId);
  if (kdtIds.length === 0) return;
  const token = await ensureAccessToken(hq);
  await callYouzanApiVerbose({
    accessToken: token,
    method: "youzan.retail.open.spu.update",
    version: "3.0.0",
    params: {
      spu_id: hqSpuId,
      sell_channel_ids: kdtIds,
    },
    timeoutMs: 30_000,
  });
}

export const pushSkuAsNewYouzanItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ sku_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const r = await ensureHqSpuLink(data.sku_id);
    return { ok: true, yz_item_id: r.yz_item_id, created: r.created };
  });


// ============================================================
// pullYouzanItemAsSku —— 从有赞商品拉到本地建 SKU 占位并绑定
// ============================================================
export const pullYouzanItemAsSku = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        yz_item_id: z.number().int().positive(),
        category: z.string().min(1).default("uncategorized"),
        price_tier: z.number().positive().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const hq = await getHqShop();
    const { data: item } = await supabase
      .from("youzan_items")
      .select("item_id, title, price, stock_qty, pic_url")
      .eq("shop_id", hq.id)
      .eq("item_id", data.yz_item_id)
      .maybeSingle();
    if (!item) throw new Error("有赞商品不存在或未同步到本地");

    // 已被绑定？
    const { data: existed } = await supabase
      .from("sku_youzan_links")
      .select("sku_id")
      .eq("yz_item_id", data.yz_item_id)
      .maybeSingle();
    if (existed) throw new Error("该有赞商品已被其它本地 SKU 占用");

    const priceTier = data.price_tier ?? Number(item.price ?? 0);

    // 生成 EPC（沿用 category-price-name 规则，加 yz: 前缀避免冲突）
    const epc = `yz-${data.yz_item_id}-${Date.now()}`;
    const { data: sku, error } = await supabase
      .from("inv_skus")
      .insert({
        category: data.category,
        price_tier: priceTier,
        name: item.title || `有赞商品 ${item.item_id}`,
        kind: "single",
        epc,
        image_url: item.pic_url ?? null,
        stock_qty: Number(item.stock_qty ?? 0),
        is_custom_price: false,
        status: "active",
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    await supabase.from("sku_youzan_links").insert({
      sku_id: sku.id,
      shop_id: hq.id,
      yz_item_id: data.yz_item_id,
      status: "linked",
      last_pull_stock: Number(item.stock_qty ?? 0),
      last_pull_at: new Date().toISOString(),
    } as never);

    return { ok: true, sku_id: sku.id };
  });

// ============================================================
// enqueueStockPush —— 按 SKU 入队（HQ + 全部已绑分店都推一次）
// ------------------------------------------------------------
// 语义：目标绝对值 = 该 (sku, shop 对应 location) 上的最新 inv_stocks.qty；
// 找不到对应 location 时回退到 inv_skus.stock_qty（一般是 HQ 仓库）。
// ============================================================
export async function enqueueStockPush(
  sku_id: string,
  reason: string,
): Promise<{ enqueued: number }> {
  // 只挑当前 sku 且允许推库存的 links（HQ 主 SPU sync_stock=false 自动排除）
  const { data: mine } = await supabase
    .from("sku_youzan_links")
    .select("shop_id, sync_stock")
    .eq("sku_id", sku_id);
  const targetShopIds = (mine ?? [])
    .filter((l) => (l as { sync_stock?: boolean }).sync_stock !== false)
    .map((l) => l.shop_id as string);
  if (targetShopIds.length === 0) return { enqueued: 0 };

  let enqueued = 0;
  for (const shopId of targetShopIds) {
    const { data: loc } = await supabase
      .from("inv_locations")
      .select("id")
      .eq("shop_id", shopId)
      .maybeSingle();
    const locationId = (loc?.id as string | undefined) ?? null;
    const target = await resolveShopStockTarget(sku_id, locationId, shopId);
    await supabase.from("youzan_stock_sync_queue").insert({
      sku_id,
      shop_id: shopId,
      location_id: locationId,
      target_stock: target,
      action: "push_stock",
      reason,
      status: "pending",
      next_run_at: new Date().toISOString(),
    } as never);
    enqueued += 1;
  }
  return { enqueued };
}

// 按 (sku, location) 直接入队（handheld 入库 / 出库 / 收货 场景推荐调用）
// 规则：
//  - 库位没有 shop_id（= 仓库）→ 直接跳过，永远不推
//  - 该 shop 没有 sku_youzan_links → 跳过（未来 v2.1 会自动 create_branch_item）
//  - link.sync_stock=false（HQ 主 SPU）→ 跳过
export async function enqueueStockPushForLocation(
  sku_id: string,
  location_id: string,
  reason: string,
): Promise<{ enqueued: boolean }> {
  const { data: loc } = await supabase
    .from("inv_locations")
    .select("id, shop_id, kind")
    .eq("id", location_id)
    .maybeSingle();
  if (!loc?.shop_id) return { enqueued: false }; // 仓库或未绑分店的库位
  if ((loc as { kind?: string }).kind !== "shop") return { enqueued: false };
  const shopId = loc.shop_id as string;

  const { data: link } = await supabase
    .from("sku_youzan_links")
    .select("id, sync_stock")
    .eq("sku_id", sku_id)
    .eq("shop_id", shopId)
    .maybeSingle();
  if (!link) return { enqueued: false }; // TODO(v2.1): 入队 create_branch_item
  if ((link as { sync_stock?: boolean }).sync_stock === false) {
    return { enqueued: false };
  }

  const target = await resolveShopStockTarget(sku_id, location_id, shopId);
  await supabase.from("youzan_stock_sync_queue").insert({
    sku_id,
    shop_id: shopId,
    location_id,
    target_stock: target,
    action: "push_stock",
    reason,
    status: "pending",
    next_run_at: new Date().toISOString(),
  } as never);
  return { enqueued: true };
}


async function resolveShopStockTarget(
  sku_id: string,
  location_id: string | null,
  _shop_id: string,
): Promise<number> {
  if (location_id) {
    const { data: st } = await supabase
      .from("inv_stocks")
      .select("qty")
      .eq("sku_id", sku_id)
      .eq("location_id", location_id)
      .maybeSingle();
    if (st) return Math.max(0, Number(st.qty ?? 0));
  }
  const { data: sku } = await supabase
    .from("inv_skus")
    .select("stock_qty")
    .eq("id", sku_id)
    .maybeSingle();
  return Math.max(0, Number(sku?.stock_qty ?? 0));
}

// ============================================================
// 内部：先入队再 await 跑一次（实时推送的"前台路径"）
// ============================================================
async function enqueueAndRun(sku_id: string, reason: string) {
  const r = await enqueueStockPush(sku_id, reason);
  if (r.enqueued) {
    try {
      await runStockSyncWorkerCore({ sku_ids: [sku_id], limit: 5 });
    } catch {
      // 失败也无所谓，cron 会兜底
    }
  }
}

// ============================================================
// runStockSyncWorker —— 消费 pending 任务（含失败回退）
// ============================================================
const BACKOFF_SEC = [30, 5 * 60, 30 * 60, 2 * 60 * 60, 6 * 60 * 60];

async function runStockSyncWorkerCore(opts: {
  sku_ids?: string[];
  limit?: number;
}): Promise<{ processed: number; ok: number; failed: number }> {
  const limit = opts.limit ?? 20;
  let q = supabase
    .from("youzan_stock_sync_queue")
    .select("*")
    .in("status", ["pending", "failed"])
    .lte("next_run_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);
  if (opts.sku_ids?.length) q = q.in("sku_id", opts.sku_ids);
  const { data: tasks, error } = await q;
  if (error) throw new Error(error.message);

  let ok = 0;
  let failed = 0;
  for (const t of tasks ?? []) {
    // 占位 running
    await supabase
      .from("youzan_stock_sync_queue")
      .update({ status: "running" } as never)
      .eq("id", t.id);

    try {
      // 按 (sku, shop) 精确取 link；老队列可能没有 shop_id，退回 sku 唯一 link
      let linkQuery = supabase
        .from("sku_youzan_links")
        .select("*")
        .eq("sku_id", t.sku_id);
      if (t.shop_id) linkQuery = linkQuery.eq("shop_id", t.shop_id);
      let { data: link } = await linkQuery.maybeSingle();

      // 自愈：没有 link 或 link 处于 error/未拿到 item_id → 尝试上架
      const needsListing =
        !link ||
        !(link as { yz_item_id?: number }).yz_item_id ||
        Number((link as { yz_item_id?: number }).yz_item_id ?? 0) <= 0;
      if (needsListing) {
        if (!t.shop_id) throw new Error("队列缺少 shop_id，无法自动上架");
        const r = await ensureBranchListing(t.sku_id, t.shop_id);
        if (!r.yz_item_id) throw new Error(r.error ?? "自动上架失败");
        const refetch = await supabase
          .from("sku_youzan_links")
          .select("*")
          .eq("sku_id", t.sku_id)
          .eq("shop_id", t.shop_id)
          .maybeSingle();
        link = refetch.data;
        if (!link) throw new Error("自动上架成功但 link 记录丢失");
      }
      if (!link) throw new Error("SKU 未绑定该门店的有赞商品");

      const action = (t as { action?: string }).action ?? "push_stock";

      // v2：HQ 主 SPU 不推库存 / 上下架，直接标 done 跳过
      if ((link as { sync_stock?: boolean }).sync_stock === false && action === "push_stock") {
        await supabase
          .from("youzan_stock_sync_queue")
          .update({
            status: "done",
            last_error: null,
            attempts: (t.attempts ?? 0) + 1,
          } as never)
          .eq("id", t.id);
        ok += 1;
        continue;
      }

      if (action === "push_is_display") {
        const targetIsDisplay = Boolean((t as { target_is_display?: boolean }).target_is_display);
        await pushIsDisplayToYouzan(link as LinkRow, targetIsDisplay);
        await supabase
          .from("youzan_stock_sync_queue")
          .update({
            status: "done",
            last_error: null,
            attempts: (t.attempts ?? 0) + 1,
          } as never)
          .eq("id", t.id);
        await supabase
          .from("sku_youzan_links")
          .update({ status: "linked", last_error: null } as never)
          .eq("id", (link as { id: string }).id);
        ok += 1;
        continue;
      }

      // 自愈：如果 location_id 存在，用当前 inv_stocks 覆盖 target，防止队列过时
      let target = Number(t.target_stock ?? 0);
      if (t.location_id) {
        target = await resolveShopStockTarget(t.sku_id, t.location_id, t.shop_id ?? "");
      }


      await pushStockToYouzan(link as LinkRow, target, t.id);

      await supabase
        .from("youzan_stock_sync_queue")
        .update({
          status: "done",
          last_error: null,
          target_stock: target,
          attempts: (t.attempts ?? 0) + 1,
        } as never)
        .eq("id", t.id);

      await supabase
        .from("sku_youzan_links")
        .update({
          last_pushed_stock: target,
          last_pushed_at: new Date().toISOString(),
          status: "linked",
          last_error: null,
        } as never)
        .eq("id", (link as { id: string }).id);
      ok += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const attempts = (t.attempts ?? 0) + 1;
      const giveUp = attempts >= BACKOFF_SEC.length;
      const nextRun = giveUp
        ? new Date(Date.now() + 24 * 3600_000).toISOString()
        : new Date(Date.now() + BACKOFF_SEC[attempts - 1] * 1000).toISOString();

      await supabase
        .from("youzan_stock_sync_queue")
        .update({
          status: giveUp ? "failed" : "failed",
          attempts,
          next_run_at: nextRun,
          last_error: msg.slice(0, 500),
        } as never)
        .eq("id", t.id);

      await supabase
        .from("sku_youzan_links")
        .update({
          status: "error",
          last_error: msg.slice(0, 500),
        } as never)
        .eq("sku_id", t.sku_id);
      failed += 1;
    }
  }
  return { processed: (tasks ?? []).length, ok, failed };
}

export const runStockSyncWorker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        sku_ids: z.array(z.string().uuid()).optional(),
        limit: z.number().min(1).max(200).default(20),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => runStockSyncWorkerCore(data));

// 给公共路由用的不带 auth 版本
export async function runStockSyncWorkerForCron() {
  return runStockSyncWorkerCore({ limit: 50 });
}

// ============================================================
// ensureHqSpu —— 确保本地 SKU 在总部有一条 SPU 绑定
// ============================================================
// ensureHqSpu —— 别名
// ============================================================
export async function ensureHqSpu(sku_id: string, addBranchShopId?: string) {
  return ensureHqSpuLink(sku_id, addBranchShopId);
}

// ============================================================
// ensureBranchProduct —— 分店"上架" = HQ SPU 的 sell_channel_ids 包含该分店
// ------------------------------------------------------------
// 连锁零售：分店无权自建商品；必须由总部 spu.create（或 spu.update）
// 把分店 kdt_id 放进 sell_channel_ids。offline_create=true 让 SPU 直接
// 在门店铺可销售。
//
// 流程：
//  1. 已有 branch_stock link 且 yz_item_id>0 → 直接返回
//  2. 无 HQ SPU → 走 spu.create（把该分店 kdt_id 放进 sell_channel_ids）
//  3. 有 HQ SPU 但该分店不在 channels → 走 spu.update 追加
//  4. upsert branch_stock link（yz_item_id 复用 HQ spu_id，方便 stock.adjust 定位）
// ============================================================
export async function ensureBranchProduct(
  sku_id: string,
  shop_id: string,
): Promise<{ yz_item_id: number | null; created: boolean; error?: string }> {
  const { data: existed } = await supabase
    .from("sku_youzan_links")
    .select("yz_item_id")
    .eq("sku_id", sku_id)
    .eq("shop_id", shop_id)
    .maybeSingle();
  if (existed?.yz_item_id && Number(existed.yz_item_id) > 0) {
    return { yz_item_id: Number(existed.yz_item_id), created: false };
  }

  try {
    const { data: branch } = await supabase
      .from("youzan_shops")
      .select("id, kdt_id, role")
      .eq("id", shop_id)
      .maybeSingle();
    if (!branch) throw new Error("门店不存在");
    if ((branch as { role?: string }).role !== "branch") {
      throw new Error("目标店铺不是分店，不能铺货");
    }

    // 已有 HQ SPU？
    const hq = await getHqShop();
    const { data: hqLink } = await supabase
      .from("sku_youzan_links")
      .select("yz_item_id")
      .eq("sku_id", sku_id)
      .eq("shop_id", hq.id)
      .maybeSingle();
    let hqSpuId = Number(hqLink?.yz_item_id ?? 0);

    if (!hqSpuId) {
      // Step A: 无 HQ SPU → 一步 create，同时铺到目标分店
      const hqInfo = await ensureHqSpu(sku_id, shop_id);
      hqSpuId = hqInfo.yz_item_id;
    } else {
      // Step B: 已有 HQ SPU → 追加分店到 channels
      await addBranchToHqSpu(sku_id, hqSpuId, shop_id);
    }

    if (!hqSpuId) throw new Error("HQ SPU id 缺失");

    // upsert branch_stock link（分店 item_id 复用 hq spu_id，stock.adjust 用 spu_id + kdt_id 定位）
    await supabase.from("sku_youzan_links").upsert(
      {
        sku_id,
        shop_id,
        yz_item_id: hqSpuId,
        status: "linked",
        sync_stock: true,
        role: "branch_stock",
        last_error: null,
      } as never,
      { onConflict: "sku_id,shop_id" },
    );
    return { yz_item_id: hqSpuId, created: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase.from("sku_youzan_links").upsert(
      {
        sku_id,
        shop_id,
        yz_item_id: 0,
        status: "error",
        sync_stock: false,
        role: "branch_stock",
        last_error: msg.slice(0, 400),
      } as never,
      { onConflict: "sku_id,shop_id" },
    );
    return { yz_item_id: null, created: false, error: msg };
  }
}


// ============================================================
// ensureBranchListing —— 兼容旧调用点，转调 ensureBranchProduct
// ============================================================
export async function ensureBranchListing(
  sku_id: string,
  shop_id: string,
): Promise<{ yz_item_id: number | null; created: boolean; error?: string }> {
  return ensureBranchProduct(sku_id, shop_id);
}


// ============================================================
// triggerStockWorker —— 服务端 fire-and-forget，异步跑一次 worker（不阻塞响应）
// 手持机端点、shop-products、hooks 都可以调
// ============================================================
export function triggerStockWorker(opts: { sku_ids?: string[]; limit?: number } = {}) {
  void runStockSyncWorkerCore({
    sku_ids: opts.sku_ids,
    limit: opts.limit ?? 5,
  }).catch(() => undefined);
}

// ============================================================
// repairMismatch —— 一键以本地为准重推
// ============================================================
export const repairMismatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ sku_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    await enqueueAndRun(data.sku_id, "repair");
    return { ok: true };
  });

// ============================================================
// reconcileAll —— 全量对账（用 youzan_items 当数据源）
// ============================================================
async function reconcileAllCore(): Promise<{
  total: number;
  mismatch: number;
}> {
  const hq = await getHqShop();
  const { data: rows } = await supabase
    .from("sku_youzan_links")
    .select("id, sku_id, yz_item_id");

  const links = rows ?? [];
  if (links.length === 0) return { total: 0, mismatch: 0 };

  const skuIds = links.map((l) => l.sku_id);
  const itemIds = links.map((l) => l.yz_item_id);

  const [{ data: skus }, { data: yzItems }] = await Promise.all([
    supabase.from("inv_skus").select("id, stock_qty").in("id", skuIds),
    supabase
      .from("youzan_items")
      .select("item_id, stock_qty")
      .eq("shop_id", hq.id)
      .in("item_id", itemIds),
  ]);

  const skuMap = new Map((skus ?? []).map((s) => [s.id, Number(s.stock_qty ?? 0)]));
  const yzMap = new Map((yzItems ?? []).map((y) => [y.item_id, Number(y.stock_qty ?? 0)]));

  let mismatch = 0;
  const now = new Date().toISOString();
  for (const l of links) {
    const local = skuMap.get(l.sku_id) ?? 0;
    const remote = yzMap.get(l.yz_item_id);
    if (remote === undefined) continue; // 有赞侧未同步过缓存，跳过
    const isMismatch = local !== remote;
    await supabase
      .from("sku_youzan_links")
      .update({
        last_pull_stock: remote,
        last_pull_at: now,
        status: isMismatch ? "mismatch" : "linked",
      } as never)
      .eq("id", l.id);
    if (isMismatch) mismatch += 1;
  }
  return { total: links.length, mismatch };
}

export const reconcileAll = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => reconcileAllCore());

export async function reconcileAllForCron() {
  return reconcileAllCore();
}

// ============================================================
// 视图查询
// ============================================================
export const listSkuLinks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        status: z.enum(["all", "linked", "mismatch", "error"]).default("all"),
        limit: z.number().min(1).max(500).default(200),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    let q = supabase
      .from("sku_youzan_links")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(data.limit);
    if (data.status !== "all") q = q.eq("status", data.status);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });

export const listSyncQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        status: z.enum(["all", "pending", "running", "done", "failed"]).default("all"),
        sku_id: z.string().uuid().optional(),
        limit: z.number().min(1).max(500).default(100),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    let q = supabase
      .from("youzan_stock_sync_queue")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.status !== "all") q = q.eq("status", data.status);
    if (data.sku_id) q = q.eq("sku_id", data.sku_id);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });

export const retryQueueItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    await supabase
      .from("youzan_stock_sync_queue")
      .update({
        status: "pending",
        next_run_at: new Date().toISOString(),
        last_error: null,
      } as never)
      .eq("id", data.id);
    await runStockSyncWorkerCore({ limit: 5 });
    return { ok: true };
  });

// ============================================================
// 未绑定列表（同步中心用）
// ============================================================
export const listUnboundLocalSkus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { data: links } = await supabase
      .from("sku_youzan_links")
      .select("sku_id");
    const boundIds = new Set((links ?? []).map((l) => l.sku_id));
    const { data: skus } = await supabase
      .from("inv_skus")
      .select("id, name, category, price_tier, stock_qty, image_url, status")
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(500);
    const rows = (skus ?? []).filter((s) => !boundIds.has(s.id));
    return { rows };
  });

export const listUnboundYouzanItems = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const hq = await getHqShop().catch(() => null);
    if (!hq) return { rows: [] };
    const { data: links } = await supabase
      .from("sku_youzan_links")
      .select("yz_item_id");
    const boundIds = new Set((links ?? []).map((l) => l.yz_item_id));
    const { data: items } = await supabase
      .from("youzan_items")
      .select("id, item_id, title, price, stock_qty, pic_url, is_listed")
      .eq("shop_id", hq.id)
      .order("updated_at", { ascending: false })
      .limit(500);
    const rows = (items ?? []).filter((i) => !boundIds.has(i.item_id));
    return { rows };
  });

// ============================================================
// getSkuLink —— 详情页用
// ============================================================
export const getSkuLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ sku_id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { data: link } = await supabase
      .from("sku_youzan_links")
      .select("*")
      .eq("sku_id", data.sku_id)
      .maybeSingle();
    const { data: recent } = await supabase
      .from("youzan_stock_sync_queue")
      .select("*")
      .eq("sku_id", data.sku_id)
      .order("created_at", { ascending: false })
      .limit(5);
    return { link, recent: recent ?? [] };
  });

// ============================================================
// listShopHealth —— /youzan 页 "系统检查" 面板数据源
// ------------------------------------------------------------
// 对齐 10 条设计原则中的 #4 / #10：
//  - youzan_shops：role / kdt_id / parent_kdt_id / 是否已绑 location
//  - 分店库存模式（sync_stock 判定）
//  - inv_locations kind=shop 但 shop_id=null → 警告
// ============================================================
export const listShopHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { data: shops } = await supabase
      .from("youzan_shops")
      .select("id, shop_name, kdt_id, parent_kdt_id, role, status")
      .order("role", { ascending: true })
      .order("shop_name", { ascending: true });

    const { data: locs } = await supabase
      .from("inv_locations")
      .select("id, name, kind, shop_id, is_active");

    const { data: links } = await supabase
      .from("sku_youzan_links")
      .select("shop_id, sync_stock");

    const shopRows = (shops ?? []).map((s) => {
      const boundLoc = (locs ?? []).find((l) => l.shop_id === s.id) ?? null;
      const shopLinks = (links ?? []).filter((l) => l.shop_id === s.id);
      const totalLinks = shopLinks.length;
      const stockLinks = shopLinks.filter(
        (l) => (l as { sync_stock?: boolean }).sync_stock !== false,
      ).length;
      const issues: string[] = [];
      if (s.role === "branch" && !s.parent_kdt_id) {
        issues.push("分店未填写 parent_kdt_id");
      }
      if (s.role === "branch" && !boundLoc) {
        issues.push("尚未绑定 inv_locations（无法按库位推库存）");
      }
      if (s.role === "hq" && stockLinks > 0) {
        issues.push(`总部有 ${stockLinks} 条 sync_stock=true 的绑定（应为 0）`);
      }
      return {
        id: s.id,
        shop_name: s.shop_name,
        kdt_id: s.kdt_id,
        parent_kdt_id: s.parent_kdt_id ?? null,
        role: s.role,
        status: s.status,
        bound_location: boundLoc
          ? { id: boundLoc.id, name: boundLoc.name, kind: boundLoc.kind }
          : null,
        stock_mode:
          s.role === "hq" ? "master_spu" : "independent_stock",
        link_count: totalLinks,
        stock_sync_count: stockLinks,
        issues,
      };
    });

    const orphanShopLocations = (locs ?? [])
      .filter((l) => l.kind === "shop" && !l.shop_id)
      .map((l) => ({ id: l.id, name: l.name, is_active: l.is_active }));

    return { shops: shopRows, orphan_shop_locations: orphanShopLocations };
  });
