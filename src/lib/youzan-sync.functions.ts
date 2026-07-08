import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  callYouzanApiVerbose,
  ensureAccessToken,
  explainYouzanError,
  getHqShop,
} from "./youzan.functions";

const AUTO_YOUZAN_GROUP_NAME = "ERP自动同步";
const DEFAULT_RETAIL_PRODUCT_CATEGORY_ID = 90747747;
const DEFAULT_RETAIL_UNIT = "件";

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
  const warehouseCode = await resolveYouzanWarehouseCode(hqToken, branchShop.kdt_id);

  const params: Record<string, unknown> = {
    kdt_id: branchShop.kdt_id,
    warehouse_code: warehouseCode,
    source_order_no: clientSeq,
    create_time: formatYouzanDateTime(new Date()),
    order_items: [
      {
        quantity: String(num),
        ...(link.yz_sku_id ? { sku_id: link.yz_sku_id } : {}),
        ...(!link.yz_sku_id && sku?.sku_code ? { sku_code: sku.sku_code } : {}),
      },
    ],
  };
  if (hqSpuId) (params.order_items as Array<Record<string, unknown>>)[0].spu_id = hqSpuId;

  await callYouzanApiVerbose({
    accessToken: hqToken,
    method: "youzan.retail.open.stock.adjust",
    version: "3.0.0",
    params,
    timeoutMs: 20_000,
  });
}

function formatYouzanDateTime(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function collectWarehouseRows(payload: unknown): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && !Array.isArray(item)) rows.push(item as Record<string, unknown>);
      }
      return;
    }
    const obj = value as Record<string, unknown>;
    for (const key of ["warehouses", "warehouse_list", "warehouseList", "list", "records", "data", "response"]) {
      walk(obj[key], depth + 1);
    }
  };
  walk(payload);
  return rows;
}

async function resolveYouzanWarehouseCode(token: string, branchKdtId: number) {
  const res = await callYouzanApiVerbose({
    accessToken: token,
    method: "youzan.retail.open.warehouse.query",
    version: "3.0.0",
    params: { kdt_id: branchKdtId, page_no: 1, page_size: 20 },
    timeoutMs: 20_000,
  });
  const rows = collectWarehouseRows(res.payload);
  const row = rows.find((r) => Number(r.warehouse_id ?? r.kdt_id ?? 0) === branchKdtId) ?? rows[0];
  const code = String(row?.warehouse_code ?? row?.warehouseCode ?? "").trim();
  if (!code) throw new Error(`无法获取门店仓库编码：${res.preview.slice(0, 200)}`);
  return code;
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
function parseStoredYouzanCategoryId(rawValue: unknown) {
  const id = Number(
    typeof rawValue === "number"
      ? rawValue
      : typeof rawValue === "string"
        ? rawValue
        : (rawValue as { id?: number } | null)?.id ?? 0,
  );
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function collectGroupNodes(payload: unknown): Array<{ id: number; name: string }> {
  const out: Array<{ id: number; name: string }> = [];
  const seen = new Set<number>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const o = value as Record<string, unknown>;
    const id = Number(o.group_id ?? o.category_id ?? o.tag_id ?? o.id ?? o.cid);
    const name = String(
      o.group_name ?? o.category_name ?? o.tag_name ?? o.name ?? o.title ?? "",
    ).trim();
    if (id > 0 && name && !seen.has(id)) {
      seen.add(id);
      out.push({ id, name });
    }
    for (const child of Object.values(o)) walk(child);
  };
  walk(payload);
  return out;
}

function pickGroupId(payload: unknown) {
  const nodes = collectGroupNodes(payload);
  return nodes[0]?.id ?? 0;
}

async function saveAutoYouzanGroupId(id: number) {
  await supabase.from("app_settings").upsert({
    key: "youzan_hq_default_category_id",
    value: { id, name: AUTO_YOUZAN_GROUP_NAME, auto: true },
    updated_at: new Date().toISOString(),
  } as never);
}

async function findAutoYouzanGroup(token: string) {
  const attempts = [
    {
      method: "youzan.item.group.list",
      version: "1.0.0",
      params: { page_no: 1, page_size: 100 },
    },
    {
      method: "youzan.item.group.search",
      version: "1.0.0",
      params: { keyword: AUTO_YOUZAN_GROUP_NAME, page_no: 1, page_size: 50 },
    },
    {
      method: "youzan.itemcategories.tags.get",
      version: "3.0.0",
      params: {},
    },
  ];

  for (const attempt of attempts) {
    try {
      const res = await callYouzanApiVerbose({
        accessToken: token,
        method: attempt.method,
        version: attempt.version,
        params: attempt.params,
        timeoutMs: 20_000,
      });
      const found = collectGroupNodes(res.payload).find((g) => g.name === AUTO_YOUZAN_GROUP_NAME);
      if (found?.id) return found.id;
    } catch {
      // 查找只是兜底，失败不阻断后面的创建/同步。
    }
  }
  return 0;
}

export async function ensureAutoYouzanDefaultCategory(): Promise<{ id: number; created: boolean }> {
  const { data: setting } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "youzan_hq_default_category_id")
    .maybeSingle();
  const storedId = parseStoredYouzanCategoryId((setting as { value?: unknown } | null)?.value);
  if (storedId > 0) return { id: storedId, created: false };

  const hq = await getHqShop();
  const token = await ensureAccessToken(hq);

  const existingId = await findAutoYouzanGroup(token);
  if (existingId > 0) {
    await saveAutoYouzanGroupId(existingId);
    return { id: existingId, created: false };
  }

  const createAttempts: Array<{ method: string; version: string; params: Record<string, unknown> }> = [
    {
      method: "youzan.itemcategories.tag.add",
      version: "3.0.0",
      params: { name: AUTO_YOUZAN_GROUP_NAME },
    },
    {
      method: "youzan.item.group.create",
      version: "1.0.0",
      params: { title: AUTO_YOUZAN_GROUP_NAME, parent_group_id: 0, kdtId: hq.kdt_id },
    },
    {
      method: "youzan.item.group.create",
      version: "1.0.0",
      params: { title: AUTO_YOUZAN_GROUP_NAME, parent_group_id: 0, kdt_id: hq.kdt_id },
    },
    {
      method: "youzan.item.group.create",
      version: "1.0.0",
      params: { title: AUTO_YOUZAN_GROUP_NAME, parent_id: 0, kdtId: hq.kdt_id },
    },
    {
      method: "youzan.item.group.create",
      version: "1.0.0",
      params: { group_name: AUTO_YOUZAN_GROUP_NAME, parent_group_id: 0, kdtId: hq.kdt_id },
    },
  ];
  let lastError = "";
  for (const attempt of createAttempts) {
    try {
      const res = await callYouzanApiVerbose({
        accessToken: token,
        method: attempt.method,
        version: attempt.version,
        params: attempt.params,
        timeoutMs: 20_000,
      });
      const createdId = pickGroupId(res.payload) || (await findAutoYouzanGroup(token));
      if (createdId > 0) {
        await saveAutoYouzanGroupId(createdId);
        return { id: createdId, created: true };
      }
      lastError = `有赞说创建成功，但没返回分组 ID：${res.preview.slice(0, 200)}`;
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      lastError = raw;
      if (/已存在|重复|duplicate|exist/i.test(raw)) {
        const id = await findAutoYouzanGroup(token);
        if (id > 0) {
          await saveAutoYouzanGroupId(id);
          return { id, created: false };
        }
      }
      if (/gw\s*4005|非法的\s*API|invalid\s*api/i.test(raw)) break;
    }
  }

  throw new Error(
    `系统已经自动尝试去有赞创建「${AUTO_YOUZAN_GROUP_NAME}」分组，但有赞没通过：${lastError}`,
  );
}

async function resolveHqCategoryId(_sku?: unknown): Promise<number> {
  // 用户决定：ERP 类目不再和有赞分组一一绑定；同步 SPU 时统一走全局默认分组。
  // 如果还没保存默认分组，系统主动去有赞创建/复用「ERP自动同步」，不再要求人工操作。
  const { data: setting } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "youzan_hq_default_category_id")
    .maybeSingle();
  const id = parseStoredYouzanCategoryId((setting as { value?: unknown } | null)?.value);
  if (id > 0) return id;
  const auto = await ensureAutoYouzanDefaultCategory();
  return auto.id;
}

async function resolveHqRetailProductCategoryId(): Promise<number> {
  const hq = await getHqShop();
  const { data: cachedItems } = await supabase
    .from("youzan_items")
    .select("raw")
    .eq("shop_id", hq.id)
    .order("updated_at", { ascending: false })
    .limit(100);

  const candidates: Array<{ id: number; name: string }> = [];
  for (const row of cachedItems ?? []) {
    const raw = (row as { raw?: unknown }).raw as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") continue;
    const directId = Number(raw.category_id ?? 0);
    const directName = String(raw.category_name ?? "").trim();
    if (directId > 0) candidates.push({ id: directId, name: directName });
    const skus = Array.isArray(raw.skus) ? (raw.skus as Array<Record<string, unknown>>) : [];
    for (const sku of skus) {
      const id = Number(sku.category_id ?? 0);
      const name = String(sku.category_name ?? "").trim();
      if (id > 0) candidates.push({ id, name });
    }
  }
  return (
    candidates.find((c) => c.name === "未分类")?.id ??
    candidates[0]?.id ??
    DEFAULT_RETAIL_PRODUCT_CATEGORY_ID
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

function buildSpuCreateAttempts(sku: {
  sku_code: string;
  name: string;
  image_url?: string | null;
  notes?: string | null;
  price_tier: string | number;
  weight_g?: number | null;
}, categoryId: number, kdtIds: number[]): Array<Record<string, unknown>> {
  const priceYuan = Number(sku.price_tier).toFixed(2);
  const base: Record<string, unknown> = {
    name: sku.name,
    unit: DEFAULT_RETAIL_UNIT,
    outer_id: sku.sku_code,
    category_id: categoryId,
    offline_create: true,
    retail_price: priceYuan,
  };
  if (kdtIds.length > 0) base.sell_channel_ids = kdtIds;
  if (sku.image_url) {
    base.images = [sku.image_url];
    base.photo_url = [{ url: sku.image_url }];
  }
  if (sku.notes) {
    base.desc = sku.notes;
    base.description = sku.notes;
  }

  const skuListItem: Record<string, unknown> = {
    outer_sku_id: sku.sku_code,
    sku_no: sku.sku_code,
    sku_code: sku.sku_code,
    price: priceYuan,
    retail_price: priceYuan,
    sale_price: priceYuan,
    stock_num: 0,
    quantity: 0,
  };
  if (sku.weight_g && Number(sku.weight_g) > 0) skuListItem.weight = Number(sku.weight_g);

  return [
    {
      ...base,
    },
    {
      name: sku.name,
      unit: DEFAULT_RETAIL_UNIT,
      outer_id: sku.sku_code,
      category_id: categoryId,
      offline_create: true,
      retail_price: priceYuan,
      ...(kdtIds.length > 0 ? { sell_channel_ids: kdtIds } : {}),
      sku_list: [skuListItem],
    },
    {
      name: sku.name,
      unit: DEFAULT_RETAIL_UNIT,
      outer_id: sku.sku_code,
      category_id: categoryId,
      offline_create: true,
      ...(kdtIds.length > 0 ? { sell_channel_ids: kdtIds } : {}),
      skus: [skuListItem],
    },
    {
      name: sku.name,
      outer_id: sku.sku_code,
      category_id: categoryId,
      unit: DEFAULT_RETAIL_UNIT,
      offline_create: true,
      sku: buildSpuSkuArray(sku as { id: string; sku_code: string; name: string; price_tier: number | string; weight_g?: number | null }),
      ...(kdtIds.length > 0 ? { sell_channel_ids: kdtIds } : {}),
    },
    {
      name: sku.name,
      unit: DEFAULT_RETAIL_UNIT,
      outer_id: sku.sku_code,
      category_id: categoryId,
      retail_price: priceYuan,
      ...(kdtIds.length > 0 ? { display_on_kdt_ids: kdtIds } : {}),
    },
  ];
}

function pickCreatedSpuId(payload: unknown) {
  const visited = new Set<unknown>();
  const keys = ["spu_id", "spuId", "item_id", "itemId", "id"];
  const walk = (value: unknown, depth = 0): number => {
    if (!value || typeof value !== "object" || depth > 5 || visited.has(value)) return 0;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const id = walk(item, depth + 1);
        if (id > 0) return id;
      }
      return 0;
    }
    const obj = value as Record<string, unknown>;
    for (const key of keys) {
      const id = Number(obj[key] ?? 0);
      if (Number.isFinite(id) && id > 0) return id;
    }
    for (const child of Object.values(obj)) {
      const id = walk(child, depth + 1);
      if (id > 0) return id;
    }
    return 0;
  };
  return walk(payload);
}

function pickCreatedSpuCode(payload: unknown) {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (!payload || typeof payload !== "object") return "";
  const obj = payload as Record<string, unknown>;
  const data = obj.data;
  if (typeof data === "string" && data.trim()) return data.trim();
  for (const key of ["spu_code", "spuCode", "sku_code", "skuCode", "code", "outer_id"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function collectSpuRowsFromPayload(payload: unknown): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  const keys = ["spus", "spu_list", "spuList", "items", "list", "records"];
  const walk = (value: unknown, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && !Array.isArray(item)) rows.push(item as Record<string, unknown>);
      }
      return;
    }
    const obj = value as Record<string, unknown>;
    for (const key of keys) walk(obj[key], depth + 1);
    for (const key of ["data", "response", "result"]) walk(obj[key], depth + 1);
  };
  walk(payload);
  return rows;
}

async function findCreatedHqSpu(token: string, code: string, name: string) {
  const res = await callYouzanApiVerbose({
    accessToken: token,
    method: "youzan.retail.open.spu.query",
    version: "3.0.0",
    params: { page_no: 1, page_size: 20 },
    timeoutMs: 20_000,
  });
  const rows = collectSpuRowsFromPayload(res.payload);
  const matched = rows.find((row) => {
    const skus = Array.isArray(row.skus) ? (row.skus as Array<Record<string, unknown>>) : [];
    return (
      (code && String(row.spu_code ?? row.spuCode ?? "") === code) ||
      String(row.product_name ?? row.productName ?? row.name ?? "") === name ||
      (code && skus.some((sku) => String(sku.sku_code ?? sku.skuCode ?? "") === code))
    );
  });
  if (!matched) return { spuId: 0, skuId: null as number | null };
  const skus = Array.isArray(matched.skus) ? (matched.skus as Array<Record<string, unknown>>) : [];
  const skuId = Number(skus[0]?.sku_id ?? skus[0]?.skuId ?? 0) || null;
  return {
    spuId: Number(matched.spu_id ?? matched.spuId ?? matched.item_id ?? matched.id ?? 0),
    skuId,
  };
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
): Promise<{ created: boolean; yz_item_id: number; shop_id: string; yz_sku_id?: number | null }> {
  const hq = await getHqShop();
  // 已有 HQ 绑定则直接返回（不改 sell_channel_ids）
  const { data: existed } = await supabase
    .from("sku_youzan_links")
    .select("yz_item_id, yz_sku_id")
    .eq("sku_id", sku_id)
    .eq("shop_id", hq.id)
    .maybeSingle();
  if (existed?.yz_item_id && Number(existed.yz_item_id) > 0) {
    return {
      created: false,
      yz_item_id: Number(existed.yz_item_id),
      shop_id: hq.id,
      yz_sku_id: Number(existed.yz_sku_id ?? 0) || null,
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
  await resolveHqCategoryId(sku as { category?: string | null });
  const categoryId = await resolveHqRetailProductCategoryId();
  const { kdtIds } = await collectSellChannelKdtIds(sku_id, scope, addBranchShopId);


  const token = await ensureAccessToken(hq);
  let newSpuId = 0;
  let newSkuId: number | null = null;
  let lastPreview = "";
  let lastError = "";
  const attempts = buildSpuCreateAttempts(
    sku as {
      sku_code: string;
      name: string;
      image_url?: string | null;
      notes?: string | null;
      price_tier: string | number;
      weight_g?: number | null;
    },
    categoryId,
    kdtIds,
  );
  const existingRemote = await findCreatedHqSpu(token, "", sku.name);
  if (existingRemote.spuId > 0) {
    newSpuId = existingRemote.spuId;
    newSkuId = existingRemote.skuId;
  }
  for (const params of newSpuId > 0 ? [] : attempts) {
    try {
      const res = await callYouzanApiVerbose({
        accessToken: token,
        method: "youzan.retail.open.spu.create",
        version: "3.0.0",
        params,
        timeoutMs: 30_000,
      });
      lastPreview = res.preview;
      newSpuId = pickCreatedSpuId(res.payload);
      if (!newSpuId) {
        const code = pickCreatedSpuCode(res.payload);
        if (code) {
          const found = await findCreatedHqSpu(token, code, sku.name);
          newSpuId = found.spuId;
          newSkuId = found.skuId;
        }
      }
      if (newSpuId > 0) break;
      lastError = `spu.create 未返回 spu_id：${res.preview.slice(0, 200)}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (/gw\s*4005|非法的\s*API|invalid\s*api/i.test(lastError)) break;
    }
  }
  if (!newSpuId) {
    throw new Error(lastError || `spu.create 未返回 spu_id：${lastPreview.slice(0, 200)}`);
  }

  await supabase.from("sku_youzan_links").upsert(
    {
      sku_id,
      shop_id: hq.id,
      yz_item_id: newSpuId,
      yz_sku_id: newSkuId,
      status: "linked",
      role: "hq_spu",
      sync_stock: false,
      last_error: null,
    } as never,
    { onConflict: "sku_id,shop_id" },
  );
  return { created: true, yz_item_id: newSpuId, yz_sku_id: newSkuId, shop_id: hq.id };
}

/**
 * 把某分店追加到已存在的 HQ SPU 的 sell_channel_ids。
 * 用 youzan.retail.open.spu.update.3.0.0，spu_id + 全量 sell_channel_ids。
 */
async function addBranchToHqSpu(sku_id: string, hqSpuId: number, addBranchShopId: string): Promise<void> {
  const hq = await getHqShop();
  const { data: sku } = await supabase
    .from("inv_skus")
    .select("sku_scope")
    .eq("id", sku_id)
    .maybeSingle();
  const scope: "standard" | "custom" =
    ((sku as { sku_scope?: string } | null)?.sku_scope === "custom" ? "custom" : "standard");
  const { kdtIds } = await collectSellChannelKdtIds(sku_id, scope, addBranchShopId);
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
      const msg = explainYouzanError(e);
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
    .select("yz_item_id, yz_sku_id")
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
      .select("yz_item_id, yz_sku_id")
      .eq("sku_id", sku_id)
      .eq("shop_id", hq.id)
      .maybeSingle();
    let hqSpuId = Number(hqLink?.yz_item_id ?? 0);
    let hqSkuId = Number(hqLink?.yz_sku_id ?? 0) || null;

    if (!hqSpuId) {
      // Step A: 无 HQ SPU → 一步 create，同时铺到目标分店
      const hqInfo = await ensureHqSpu(sku_id, shop_id);
      hqSpuId = hqInfo.yz_item_id;
      hqSkuId = hqInfo.yz_sku_id ?? null;
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
        yz_sku_id: hqSkuId,
        status: "linked",
        sync_stock: true,
        role: "branch_stock",
        last_error: null,
      } as never,
      { onConflict: "sku_id,shop_id" },
    );
    return { yz_item_id: hqSpuId, created: true };
  } catch (e) {
    const msg = explainYouzanError(e);
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

// ============================================================
// cleanupHqSpusByNames —— 一次性清理有赞总部误建的 SPU
// ------------------------------------------------------------
// 传入名称白名单（如 ["probe-channel-a","probe-channel-b","probe-channel-c","test","测试商品"]）
// 会：分页拉总部所有 SPU → 匹配名称 → 保护 sku_youzan_links(role=hq_spu) 已绑定的 spu_id
// → 其余尝试用 youzan.retail.open.spu.delete/3.0.0 删除，逐条记录返回。
// ============================================================
export const cleanupHqSpusByNames = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        names: z.array(z.string().trim().min(1)).min(1).max(20),
        dry_run: z.boolean().default(false),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const hq = await getHqShop();
    const token = await ensureAccessToken(hq);

    // 1. 拉总部所有 SPU（最多 5 页 × 100）
    const allRows: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= 5; page += 1) {
      const res = await callYouzanApiVerbose({
        accessToken: token,
        method: "youzan.retail.open.spu.query",
        version: "3.0.0",
        params: { page_no: page, page_size: 100 },
        timeoutMs: 25_000,
      });
      const rows = collectSpuRowsFromPayload(res.payload);
      if (rows.length === 0) break;
      allRows.push(...rows);
      if (rows.length < 100) break;
    }

    // 2. 拿到已绑定的 hq spu_id，避免误删
    const { data: linkedRows } = await supabase
      .from("sku_youzan_links")
      .select("yz_item_id")
      .eq("role", "hq_spu");
    const protectedIds = new Set(
      (linkedRows ?? []).map((r) => Number(r.yz_item_id)).filter((n) => n > 0),
    );

    const wantNames = new Set(data.names.map((s) => s.trim()));
    const candidates = allRows
      .map((row) => {
        const name = String(
          row.product_name ?? row.productName ?? row.name ?? row.title ?? "",
        ).trim();
        const spuId = Number(
          row.spu_id ?? row.spuId ?? row.item_id ?? row.id ?? 0,
        );
        return { name, spuId };
      })
      .filter((r) => r.spuId > 0 && wantNames.has(r.name));

    const toDelete = candidates.filter((r) => !protectedIds.has(r.spuId));
    const kept = candidates.filter((r) => protectedIds.has(r.spuId));

    if (data.dry_run) {
      return {
        total_scanned: allRows.length,
        matched: candidates,
        kept,
        will_delete: toDelete,
      };
    }

    const results: Array<{ spuId: number; name: string; ok: boolean; message: string }> = [];
    for (const item of toDelete) {
      let ok = false;
      let message = "";
      // 有赞连锁零售 SPU 删除接口
      const methods: Array<{ method: string; version: string; params: Record<string, unknown> }> = [
        {
          method: "youzan.retail.open.spu.delete",
          version: "3.0.0",
          params: { spu_id: item.spuId },
        },
        {
          method: "youzan.retail.open.product.delete",
          version: "1.0.0",
          params: { kdt_id: hq.kdt_id, spu_id: item.spuId },
        },
      ];
      for (const m of methods) {
        try {
          const res = await callYouzanApiVerbose({
            accessToken: token,
            method: m.method,
            version: m.version,
            params: m.params,
            timeoutMs: 20_000,
          });
          message = `${m.method}/${m.version} → ${res.preview.slice(0, 160)}`;
          if (!/error|fail|非法|不存在|4005|4001|1000/i.test(res.preview)) {
            ok = true;
            break;
          }
        } catch (e) {
          message = `${m.method}: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      results.push({ spuId: item.spuId, name: item.name, ok, message });
    }

    return {
      total_scanned: allRows.length,
      matched: candidates,
      kept,
      results,
    };
  });
