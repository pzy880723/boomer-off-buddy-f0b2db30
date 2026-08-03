// 门店商品：以"门店"为主视角展示商品和库存
// - 每家门店对应 inv_locations(kind='shop', shop_id=…)
// - 增减库存都走 inv_apply_movement；DB 触发器会自动登记 push_stock 任务
// - SKU 首次在某门店有库存时，worker 自愈上架（youzan.item.add）
//
// ⚠️ DEPRECATION NOTICE（Round A / 2026-07-05）
// `ensureBranchListing` 和 `registerNewSkuAtShop` 走的是老单店 API
// `youzan.item.add`，在连锁零售子店铺会被网关拦截（gw 4005 非法的API）。
// Round B 会换成 "HQ SPU + retail.open.product.distribute" 通道：
//   1) 仓库建 SKU → 后台 ensureHqSpu → HQ SPU 落地
//   2) 分店首次库存动作 → ensureBranchProduct 铺货 → branch item_id
//   3) push_stock / push_is_display 队列复用现有流程
// 届时删除这两个函数；目前 UI 层已在门店端隐藏"新建标准商品"入口，
// 只留自定义/组包，供切回单店模式时兜底。
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ensureBranchListing, triggerStockWorker } from "./youzan-sync.functions";
import { releaseSkuToOfflineShopsCore } from "./youzan-offline-products.functions";
import { explainYouzanError } from "./youzan.functions";

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
  .handler(
    async ({
      data,
      context,
    }): Promise<{ rows: ShopSkuRow[]; location_id: string | null; store_format: string | null }> => {
      const sb = context.supabase;
      const [{ data: loc }, { data: shop }] = await Promise.all([
        sb.from("inv_locations").select("id, name").eq("shop_id", data.shop_id).maybeSingle(),
        sb.from("youzan_shops").select("store_format").eq("id", data.shop_id).maybeSingle(),
      ]);
      const storeFormat = (shop as { store_format?: string } | null)?.store_format ?? null;
      if (!loc) return { rows: [], location_id: null, store_format: storeFormat };


    // 取该门店所有 inv_stocks（含 qty=0，方便看到"新建但入库失败"的商品）
    const { data: stocks, error: stErr } = await sb
      .from("inv_stocks")
      .select("sku_id, qty")
      .eq("location_id", loc.id);
    if (stErr) throw new Error(stErr.message);

    // 加上"有 link"的 SKU
    const { data: links } = await sb
      .from("sku_youzan_links")
      .select("sku_id")
      .eq("shop_id", data.shop_id);

    // 再加上"本门店曾经动过"的 SKU（movements 里有记录，防止上一步失败留下孤立 SKU）
    const { data: moves } = await sb
      .from("inv_stock_movements")
      .select("sku_id")
      .eq("location_id", loc.id)
      .limit(5000);

    const skuIds = new Set<string>();
    (stocks ?? []).forEach((s) => skuIds.add(s.sku_id));
    (links ?? []).forEach((l) => skuIds.add(l.sku_id));
    (moves ?? []).forEach((m) => skuIds.add(m.sku_id));
    // Vintage 门店：无条件继承总部全局标准商品目录（无限库存，无需入库 / 同步 / 建 link）
    if ((shop as { store_format?: string } | null)?.store_format === "vintage") {
      const { data: standardSkus, error: standardErr } = await sb
        .from("inv_skus")
        .select("id")
        .eq("kind", "single")
        .eq("is_custom_price", false)
        .eq("inventory_policy", "unlimited")
        .eq("is_display", true)
        .eq("status", "active")
        .limit(5000);
      if (standardErr) throw new Error(standardErr.message);
      (standardSkus ?? []).forEach((sku) => skuIds.add(sku.id));
    }

    if (skuIds.size === 0)
      return { rows: [], location_id: loc.id, store_format: storeFormat };


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

    const stockMap = new Map((stocks ?? []).map((s) => [s.sku_id, Number(s.qty)]));
    const patched: ShopSkuRow[] = (rows ?? []).map((r) => {
      const raw = r as Record<string, unknown>;
      const bi = raw.bundle_items;
      return {
        id: String(raw.id),
        category: String(raw.category ?? ""),
        name: String(raw.name ?? ""),
        sku_code: (raw.sku_code as string | null) ?? null,
        price_tier: Number(raw.price_tier ?? 0),
        is_custom_price: Boolean(raw.is_custom_price),
        inventory_policy: String(raw.inventory_policy ?? "tracked") as "tracked" | "unlimited",
        kind: String(raw.kind ?? "single"),
        pack_pieces: (raw.pack_pieces as number | null) ?? null,
        bundle_items: Array.isArray(bi) ? (bi as Array<{ sku_id: string; qty: number }>) : [],
        weight_g: (raw.weight_g as number | null) ?? null,
        image_url: (raw.image_url as string | null) ?? null,
        image_paths: (raw.image_paths as string[] | null) ?? null,
        notes: (raw.notes as string | null) ?? null,
        status: String(raw.status ?? "active"),
        epc: String(raw.epc ?? ""),
        stock_qty: stockMap.get(String(raw.id)) ?? 0,
        created_at: String(raw.created_at ?? ""),
      };
    });
    return { rows: patched, location_id: loc.id };
  });

// 门店 SKU 行（比 SkuRow 简化：bundle_items 一定是数组，方便 RPC 序列化）
export type ShopSkuRow = {
  id: string;
  category: string;
  name: string;
  sku_code: string | null;
  price_tier: number;
  is_custom_price: boolean;
  inventory_policy: "tracked" | "unlimited";
  kind: string;
  pack_pieces: number | null;
  bundle_items: Array<{ sku_id: string; qty: number }>;
  weight_g: number | null;
  image_url: string | null;
  image_paths: string[] | null;
  notes: string | null;
  status: string;
  epc: string;
  stock_qty: number;
  created_at: string;
};

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
      triggerStockWorker({ sku_ids: [data.sku_id] });
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
      stock_ok: boolean;
      listing_ok: boolean;
      listing_error: string | null;
      error: string | null;
    }> = [];
    for (const sku_id of data.sku_ids) {
      let new_qty = 0;
      let stock_ok = false;
      let listing_ok = false;
      let yz_item_id: number | null = null;
      let listing_error: string | null = null;
      let error: string | null = null;
      try {
        const { data: newQty, error: mvErr } = await supabase.rpc("inv_apply_movement", {
          p_sku_id: sku_id,
          p_location_id: location_id,
          p_delta: data.qty_each,
          p_ref_type: "shop_new_sku",
          p_ref_id: null,
          p_epc: null,
          p_note: "新建 SKU 首店入库",
        } as never);
        if (mvErr) throw new Error(mvErr.message);
        new_qty = Number(newQty ?? 0);
        stock_ok = true;
      } catch (e) {
        error = `入库失败：${(e as Error).message}`;
        // 兜底：即便入库失败，也 upsert 一行 qty=0 的 inv_stocks，让 SKU 在列表里可见
        await supabase
          .from("inv_stocks")
          .upsert(
            { sku_id, location_id, qty: 0, updated_at: new Date().toISOString() } as never,
            { onConflict: "sku_id,location_id", ignoreDuplicates: true } as never,
          );
      }
      try {
        const release = await releaseSkuToOfflineShopsCore({
          sku_id,
          shop_ids: [data.shop_id],
          stock_override: new_qty,
        });
        const listing = release.results[0];
        yz_item_id = listing?.item_id ?? null;
        listing_error = listing?.error ?? null;
        listing_ok = Boolean(listing?.ok && listing.item_id);
        if (listing_ok) triggerStockWorker({ sku_ids: [sku_id] });
      } catch (e) {
        listing_error = (e as Error).message;
      }
      results.push({ sku_id, new_qty, yz_item_id, stock_ok, listing_ok, listing_error, error });
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
      // 触发一次库存推送（retry 场景本地未产生 movement，主动入队一次）
      const { location_id } = await getShopWithLocation(data.shop_id);
      const { data: st } = await supabase
        .from("inv_stocks")
        .select("qty")
        .eq("sku_id", data.sku_id)
        .eq("location_id", location_id)
        .maybeSingle();
      await supabase
        .from("youzan_stock_sync_queue")
        .upsert(
          {
            sku_id: data.sku_id,
            shop_id: data.shop_id,
            location_id,
            target_stock: Math.max(0, Number(st?.qty ?? 0)),
            action: "push_stock",
            reason: "retry_listing",
            status: "pending",
            next_run_at: new Date().toISOString(),
            last_error: null,
          } as never,
          { onConflict: "sku_id,shop_id", ignoreDuplicates: false } as never,
        );
      triggerStockWorker({ sku_ids: [data.sku_id] });
    }
    return {
      ok: !!r.yz_item_id,
      yz_item_id: r.yz_item_id,
      error: r.error ? explainYouzanError(r.error) : null,
    };
  });

export const retryFailedBranchListings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        shop_id: z.string().uuid(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { location_id } = await getShopWithLocation(data.shop_id);
    const { data: failedRows, error } = await supabase
      .from("sku_youzan_links")
      .select("sku_id, inv_skus(kind, is_custom_price, name)")
      .eq("shop_id", data.shop_id)
      .eq("status", "error")
      .limit(100);
    if (error) throw new Error(error.message);
    const rows = (failedRows ?? []).filter((row) => {
      const sku = (row as unknown as { inv_skus?: { kind?: string; is_custom_price?: boolean } }).inv_skus;
      return sku?.kind === "bundle" || Boolean(sku?.is_custom_price);
    });

    let ok = 0;
    let failed = 0;
    const details: Array<{ sku_id: string; ok: boolean; error: string | null }> = [];
    for (const row of rows) {
      const sku_id = String(row.sku_id);
      await supabase
        .from("sku_youzan_links")
        .delete()
        .eq("sku_id", sku_id)
        .eq("shop_id", data.shop_id)
        .eq("status", "error");
      try {
        const r = await ensureBranchListing(sku_id, data.shop_id);
        if (r.yz_item_id) {
          const { data: st } = await supabase
            .from("inv_stocks")
            .select("qty")
            .eq("sku_id", sku_id)
            .eq("location_id", location_id)
            .maybeSingle();
          await supabase.from("youzan_stock_sync_queue").upsert(
            {
              sku_id,
              shop_id: data.shop_id,
              location_id,
              target_stock: Math.max(0, Number(st?.qty ?? 0)),
              action: "push_stock",
              reason: "retry_failed_listings",
              status: "pending",
              next_run_at: new Date().toISOString(),
              last_error: null,
            } as never,
            { onConflict: "sku_id,shop_id", ignoreDuplicates: false } as never,
          );
          triggerStockWorker({ sku_ids: [sku_id] });
          ok += 1;
          details.push({ sku_id, ok: true, error: null });
        } else {
          failed += 1;
          details.push({ sku_id, ok: false, error: r.error ? explainYouzanError(r.error) : "上架失败" });
        }
      } catch (e) {
        failed += 1;
        details.push({ sku_id, ok: false, error: explainYouzanError(e) });
      }
    }

    return { total: rows.length, ok, failed, details };
  });
