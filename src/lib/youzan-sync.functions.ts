import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  callYouzanApiVerbose,
  ensureAccessToken,
  getHqShop,
} from "./youzan.functions";

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
// 内部：覆盖式推送库存到有赞总部
// ------------------------------------------------------------
// 零售连锁版调用 youzan.retail.open.stock.update.1.0.0
// 参数：kdt_id（总部）、item_id 或 sku_id、num（目标值）、type=set
// 接口若返回 [40005] / [-1] 等错误，向上抛出，由 worker 入失败队列
// ============================================================
async function pushStockToYouzan(
  link: LinkRow,
  targetStock: number,
  clientSeq: string,
): Promise<void> {
  const hq = await getHqShop();
  const token = await ensureAccessToken(hq);
  const params: Record<string, unknown> = {
    kdt_id: hq.kdt_id,
    item_id: link.yz_item_id,
    num: Math.max(0, targetStock),
    type: "set",
    client_seq: clientSeq,
  };
  if (link.yz_sku_id) params.sku_id = link.yz_sku_id;

  await callYouzanApiVerbose({
    accessToken: token,
    method: "youzan.retail.open.stock.update",
    version: "1.0.0",
    params,
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
        "id, item_id, title, price, stock_qty, sold_num, is_listed, pic_url, updated_at",
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
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const hq = await getHqShop();

    // 校验：sku 与 item 都存在
    const { data: sku } = await supabase
      .from("inv_skus")
      .select("id, name, stock_qty")
      .eq("id", data.sku_id)
      .maybeSingle();
    if (!sku) throw new Error("本地 SKU 不存在");

    const { data: yzItem } = await supabase
      .from("youzan_items")
      .select("item_id, title")
      .eq("shop_id", hq.id)
      .eq("item_id", data.yz_item_id)
      .maybeSingle();
    if (!yzItem) {
      throw new Error("有赞商品不存在，请先在「同步」里把总部商品拉到本地再试");
    }

    // 写入（upsert by sku_id）
    const { error: upErr } = await supabase
      .from("sku_youzan_links")
      .upsert(
        {
          sku_id: data.sku_id,
          shop_id: hq.id,
          yz_item_id: data.yz_item_id,
          yz_sku_id: data.yz_sku_id ?? null,
          status: "linked",
          last_error: null,
        } as never,
        { onConflict: "sku_id" },
      );
    if (upErr) throw new Error(upErr.message);

    // 立即触发一次以本地库存为准的推送
    await enqueueAndRun(data.sku_id, "link_init");

    return { ok: true, message: `已绑定「${yzItem.title}」，并按本地库存 ${sku.stock_qty} 同步` };
  });

// ============================================================
// unlinkSku
// ============================================================
export const unlinkSku = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ sku_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { error } = await supabase
      .from("sku_youzan_links")
      .delete()
      .eq("sku_id", data.sku_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ============================================================
// pushSkuAsNewYouzanItem —— 应急：本地 → 有赞建商品
// ------------------------------------------------------------
// 仅提供一个最小可用的封装；零售连锁版 spu.add 实际所需的类目 / 规格
// 字段较多，建议用户后续按需扩展。
// ============================================================
export const pushSkuAsNewYouzanItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ sku_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: sku } = await supabase
      .from("inv_skus")
      .select("*")
      .eq("id", data.sku_id)
      .maybeSingle();
    if (!sku) throw new Error("SKU 不存在");

    const hq = await getHqShop();
    const token = await ensureAccessToken(hq);

    // ⚠️ retail.open.spu.add 的真实必填字段需按你们有赞类目情况调整
    // 这里给出最小可用骨架，调通后请补全 category_id / barcode 等
    const params = {
      kdt_id: hq.kdt_id,
      product_name: sku.name,
      price: Number(sku.price_tier),
      stock_num: Number(sku.stock_qty ?? 0),
      photo_url: sku.image_url ? [sku.image_url] : [],
      desc: sku.notes ?? "",
      out_product_id: sku.id, // 我方编码，便于回查
    };

    const res = await callYouzanApiVerbose({
      accessToken: token,
      method: "youzan.retail.open.spu.add",
      version: "3.0.0",
      params,
      timeoutMs: 30_000,
    });

    const payload = res.payload as Record<string, unknown>;
    const newItemId = Number(
      payload.item_id ?? payload.spu_id ?? payload.id ?? 0,
    );
    if (!newItemId) {
      throw new Error(
        `有赞返回未识别 item_id：${res.preview.slice(0, 200)}`,
      );
    }

    // 建链
    await supabase.from("sku_youzan_links").upsert(
      {
        sku_id: sku.id,
        shop_id: hq.id,
        yz_item_id: newItemId,
        status: "linked",
      } as never,
      { onConflict: "sku_id" },
    );
    return { ok: true, yz_item_id: newItemId };
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
// enqueueStockPush —— 写入推送队列（供库存事件源调用）
// ============================================================
export async function enqueueStockPush(
  sku_id: string,
  reason: string,
): Promise<{ enqueued: boolean }> {
  const { data: link } = await supabase
    .from("sku_youzan_links")
    .select("sku_id")
    .eq("sku_id", sku_id)
    .maybeSingle();
  if (!link) return { enqueued: false }; // 未绑定，跳过

  const { data: sku } = await supabase
    .from("inv_skus")
    .select("stock_qty")
    .eq("id", sku_id)
    .maybeSingle();
  if (!sku) return { enqueued: false };

  await supabase.from("youzan_stock_sync_queue").insert({
    sku_id,
    target_stock: Number(sku.stock_qty ?? 0),
    reason,
    status: "pending",
    next_run_at: new Date().toISOString(),
  } as never);
  return { enqueued: true };
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
      const { data: link } = await supabase
        .from("sku_youzan_links")
        .select("*")
        .eq("sku_id", t.sku_id)
        .maybeSingle();
      if (!link) throw new Error("SKU 未绑定有赞商品（可能已解绑）");

      await pushStockToYouzan(link as LinkRow, t.target_stock, t.id);

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
        .update({
          last_pushed_stock: t.target_stock,
          last_pushed_at: new Date().toISOString(),
          status: "linked",
          last_error: null,
        } as never)
        .eq("id", link.id);
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
