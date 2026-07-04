// 门店商品：以"门店"为主视角展示商品和库存
// - 每家门店对应 inv_locations(kind='shop', shop_id=…)
// - 增减库存都走 inv_apply_movement；DB 触发器会自动登记 push_stock 任务
// - SKU 首次在某门店有库存时，worker 自愈上架（youzan.item.add）
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ensureBranchListing, triggerStockWorker } from "./youzan-sync.functions";

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
  .handler(async ({ data, context }): Promise<{ rows: ShopSkuRow[]; location_id: string | null }> => {
    const sb = context.supabase;
    const { data: loc } = await sb
      .from("inv_locations")
      .select("id, name")
      .eq("shop_id", data.shop_id)
      .maybeSingle();
    if (!loc) return { rows: [], location_id: null };

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
    if (skuIds.size === 0) return { rows: [], location_id: loc.id };

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
