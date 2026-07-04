// 门店商品：以"门店"为主视角展示商品和库存
// - 每家门店对应 inv_locations(kind='shop', shop_id=…)
// - 增减库存都走 inv_apply_movement，同步入队推送到有赞
// - SKU 首次在某门店有库存时，自动调 youzan.item.add 上架并建立 sku_youzan_links
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
// SkuRow is used only on the client side; server return is a plain object array
import {
  callYouzanApiVerbose,
  ensureAccessToken,
} from "./youzan.functions";

// ---------- 内部工具 ----------

async function getShopWithLocation(shop_id: string) {
  const { data: shop, error: sErr } = await supabase
    .from("youzan_shops")
    .select("*")
    .eq("id", shop_id)
    .maybeSingle();
  if (sErr) throw new Error(sErr.message);
  if (!shop) throw new Error("门店不存在");
  if ((shop as { role?: string }).role !== "branch") {
    throw new Error("只有分店可以做门店商品，总部走 SPU 主账页");
  }
  const { data: loc, error: lErr } = await supabase
    .from("inv_locations")
    .select("id, name, is_active")
    .eq("shop_id", shop_id)
    .maybeSingle();
  if (lErr) throw new Error(lErr.message);
  if (!loc) throw new Error("门店未映射库位，请联系管理员");
  if (!loc.is_active) {
    throw new Error(`门店库位「${loc.name}」已停用`);
  }
  return { shop, location_id: loc.id as string };
}

// ---------- ensureBranchListing：自动上架到有赞分店 ----------

async function ensureBranchListing(sku_id: string, shop_id: string): Promise<{
  yz_item_id: number | null;
  created: boolean;
  error?: string;
}> {
  // 已有 link
  const { data: existed } = await supabase
    .from("sku_youzan_links")
    .select("yz_item_id, status")
    .eq("sku_id", sku_id)
    .eq("shop_id", shop_id)
    .maybeSingle();
  if (existed?.yz_item_id) {
    return { yz_item_id: Number(existed.yz_item_id), created: false };
  }

  const { data: sku } = await supabase
    .from("inv_skus")
    .select("id, name, price_tier, image_url, notes, stock_qty")
    .eq("id", sku_id)
    .maybeSingle();
  if (!sku) return { yz_item_id: null, created: false, error: "SKU 不存在" };

  const { data: shop } = await supabase
    .from("youzan_shops")
    .select("*")
    .eq("id", shop_id)
    .maybeSingle();
  if (!shop) return { yz_item_id: null, created: false, error: "门店不存在" };

  try {
    const token = await ensureAccessToken(shop as never);
    const params: Record<string, unknown> = {
      title: sku.name,
      price: Number(sku.price_tier),
      num: Number(sku.stock_qty ?? 0),
      desc: sku.notes ?? sku.name,
      is_display: 1,
      is_listing: 1,
      auto_listing_time: 0,
      out_product_id: sku.id,
    };
    if (sku.image_url) params.item_imgs = sku.image_url;

    const res = await callYouzanApiVerbose({
      accessToken: token,
      method: "youzan.item.add",
      version: "3.0.0",
      params,
      timeoutMs: 25_000,
    });
    const payload = res.payload as Record<string, unknown>;
    const rawItemId = payload.item_id ?? payload.num_iid ?? payload.id;
    const itemId = Number(rawItemId ?? 0);
    if (!itemId) {
      throw new Error(`有赞未返回 item_id：${res.preview.slice(0, 160)}`);
    }
    await supabase.from("sku_youzan_links").upsert(
      {
        sku_id,
        shop_id,
        yz_item_id: itemId,
        status: "linked",
        sync_stock: true,
        role: "branch_stock",
      } as never,
      { onConflict: "sku_id,shop_id" },
    );
    return { yz_item_id: itemId, created: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 记录 pending link 让用户能在 UI 上看到错误
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

// ---------- 立即入队 + 触发一次 worker ----------

async function pushStockNow(opts: {
  sku_id: string;
  shop_id: string;
  location_id: string;
  reason: string;
}) {
  const { data: st } = await supabase
    .from("inv_stocks")
    .select("qty")
    .eq("sku_id", opts.sku_id)
    .eq("location_id", opts.location_id)
    .maybeSingle();
  const target = Math.max(0, Number(st?.qty ?? 0));
  await supabase.from("youzan_stock_sync_queue").insert({
    sku_id: opts.sku_id,
    shop_id: opts.shop_id,
    location_id: opts.location_id,
    target_stock: target,
    action: "push_stock",
    reason: opts.reason,
    status: "pending",
    next_run_at: new Date().toISOString(),
  } as never);
  // 触发 worker（异步 fire-and-forget）
  try {
    const { getRequestHost } = await import("@tanstack/react-start/server");
    const host = getRequestHost();
    if (host) {
      const scheme = host.includes("localhost") ? "http" : "https";
      void fetch(`${scheme}://${host}/api/public/hooks/youzan-stock-worker`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku_ids: [opts.sku_id], limit: 5 }),
      }).catch(() => undefined);
    }
  } catch {
    /* noop */
  }
}

// ---------- listShopSkus ----------

export const listShopSkus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        shop_id: z.string().uuid(),
        search: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const { data: loc } = await sb
      .from("inv_locations")
      .select("id, name")
      .eq("shop_id", data.shop_id)
      .maybeSingle();
    if (!loc) return { rows: [] as Record<string, unknown>[], location_id: null as string | null };

    // 取该门店所有 inv_stocks > 0 的 sku
    const { data: stocks, error: stErr } = await sb
      .from("inv_stocks")
      .select("sku_id, qty")
      .eq("location_id", loc.id)
      .gt("qty", 0);
    if (stErr) throw new Error(stErr.message);

    // 加上"有 link 但库存 0"的 SKU（下架状态，可以看到）
    const { data: links } = await sb
      .from("sku_youzan_links")
      .select("sku_id")
      .eq("shop_id", data.shop_id);

    const skuIds = new Set<string>();
    (stocks ?? []).forEach((s) => skuIds.add(s.sku_id));
    (links ?? []).forEach((l) => skuIds.add(l.sku_id));
    if (skuIds.size === 0) return { rows: [] as Record<string, unknown>[], location_id: loc.id as string | null };

    let q = sb
      .from("inv_skus")
      .select("*")
      .in("id", Array.from(skuIds))
      .order("created_at", { ascending: false });
    if (data.search) {
      const s = `%${data.search}%`;
      q = q.or(`name.ilike.${s},epc.ilike.${s},sku_code.ilike.${s}`);
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    // 用门店库存覆盖 stock_qty 字段
    const stockMap = new Map((stocks ?? []).map((s) => [s.sku_id, Number(s.qty)]));
    const patched = (rows ?? []).map((r) => ({
      ...(r as Record<string, unknown>),
      bundle_items: Array.isArray((r as { bundle_items?: unknown }).bundle_items)
        ? ((r as { bundle_items?: unknown }).bundle_items as unknown[])
        : [],
      stock_qty: stockMap.get(r.id) ?? 0,
    }));
    return { rows: patched as Record<string, unknown>[], location_id: loc.id as string | null };
  });

// ---------- addShopStock：入库 / 出库 / 调整 ----------

export const addShopStock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        shop_id: z.string().uuid(),
        sku_id: z.string().uuid(),
        delta: z.number().int(), // 支持负数
        note: z.string().max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { location_id } = await getShopWithLocation(data.shop_id);
    // inv_apply_movement (security definer)
    const { data: newQty, error } = await supabase.rpc("inv_apply_movement", {
      p_sku_id: data.sku_id,
      p_location_id: location_id,
      p_delta: data.delta,
      p_ref_type: "shop_adjust",
      p_ref_id: null,
      p_epc: null,
      p_note: data.note ?? null,
    } as never);
    if (error) throw new Error(error.message);

    // 有库存 → 确保上架；无库存 → 保留链接以便下次
    let listing: { yz_item_id: number | null; created: boolean; error?: string } = {
      yz_item_id: null,
      created: false,
    };
    if ((newQty as number) > 0) {
      listing = await ensureBranchListing(data.sku_id, data.shop_id);
    }
    if (listing.yz_item_id) {
      await pushStockNow({
        sku_id: data.sku_id,
        shop_id: data.shop_id,
        location_id,
        reason: `shop_adjust ${data.delta > 0 ? "+" : ""}${data.delta}`,
      });
    }

    return {
      ok: true,
      new_qty: newQty as number,
      yz_item_id: listing.yz_item_id,
      listing_created: listing.created,
      listing_error: listing.error ?? null,
    };
  });

// ---------- 一次创建 SKU + 首店铺入库（用于 3 个新建 dialog 完成后的回调） ----------

export const registerNewSkuAtShop = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        shop_id: z.string().uuid(),
        sku_ids: z.array(z.string().uuid()).min(1).max(50),
        qty_each: z.number().int().min(1).max(999).default(1),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { location_id } = await getShopWithLocation(data.shop_id);
    const results: Array<{
      sku_id: string;
      new_qty: number;
      yz_item_id: number | null;
      listing_error: string | null;
    }> = [];
    for (const sku_id of data.sku_ids) {
      const { data: newQty, error } = await supabase.rpc("inv_apply_movement", {
        p_sku_id: sku_id,
        p_location_id: location_id,
        p_delta: data.qty_each,
        p_ref_type: "shop_new_sku",
        p_ref_id: null,
        p_epc: null,
        p_note: "新建 SKU 首店入库",
      } as never);
      if (error) throw new Error(error.message);
      const listing = await ensureBranchListing(sku_id, data.shop_id);
      if (listing.yz_item_id) {
        await pushStockNow({
          sku_id,
          shop_id: data.shop_id,
          location_id,
          reason: "shop_new_sku",
        });
      }
      results.push({
        sku_id,
        new_qty: newQty as number,
        yz_item_id: listing.yz_item_id,
        listing_error: listing.error ?? null,
      });
    }
    return { ok: true, results };
  });

// ---------- listShopLinks：给一组 sku 拉出它们在门店的 link 状态 ----------

export const listShopLinksForSkus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        shop_id: z.string().uuid(),
        sku_ids: z.array(z.string().uuid()).max(1000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    if (data.sku_ids.length === 0) return { links: {} };
    const { data: rows } = await context.supabase
      .from("sku_youzan_links")
      .select("sku_id, yz_item_id, status, last_error")
      .eq("shop_id", data.shop_id)
      .in("sku_id", data.sku_ids);
    const map: Record<
      string,
      { yz_item_id: number; status: string; last_error: string | null }
    > = {};
    for (const r of rows ?? []) {
      map[r.sku_id] = {
        yz_item_id: Number(r.yz_item_id),
        status: r.status as string,
        last_error: (r as { last_error?: string | null }).last_error ?? null,
      };
    }
    return { links: map };
  });

// ---------- 触发一次"重新尝试上架"（用户在 UI 点重试用） ----------

export const retryBranchListing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        shop_id: z.string().uuid(),
        sku_id: z.string().uuid(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    // 清掉旧的错误 link
    await supabase
      .from("sku_youzan_links")
      .delete()
      .eq("sku_id", data.sku_id)
      .eq("shop_id", data.shop_id)
      .eq("status", "error");
    const r = await ensureBranchListing(data.sku_id, data.shop_id);
    if (r.yz_item_id) {
      const { location_id } = await getShopWithLocation(data.shop_id);
      await pushStockNow({
        sku_id: data.sku_id,
        shop_id: data.shop_id,
        location_id,
        reason: "retry_listing",
      });
    }
    return {
      ok: !!r.yz_item_id,
      yz_item_id: r.yz_item_id,
      error: r.error ?? null,
    };
  });
