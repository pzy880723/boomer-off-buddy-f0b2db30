import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import { publishSkuToHqCore, releaseSkuToBranchCore } from "./omnichannel-publish.functions";
import {
  selectStandardCatalogTargetShops,
  type StandardCatalogTargetShop,
} from "./standard-catalog-youzan-sync";
import { explainYouzanError, pushYouzanQuantityUpdate } from "./youzan.functions";

export type StandardCatalogBranchResult = {
  shop_id: string;
  shop_name: string;
  ok: boolean;
  branch_item_id?: number;
  branch_sku_id?: number;
  target_stock?: number;
  trace_id?: string | null;
  error?: string;
};

export async function listStandardCatalogTargetShops() {
  const { data, error } = await supabase
    .from("youzan_shops")
    .select("*")
    .eq("role", "branch")
    .eq("status", "active")
    .order("shop_name", { ascending: true });
  if (error) throw new Error(error.message);
  return selectStandardCatalogTargetShops(data ?? []);
}

export async function syncStandardSkuToYouzanBranchesCore(args: {
  skuId: string;
  shops: StandardCatalogTargetShop[];
  targetStock: number;
}) {
  const hq = await publishSkuToHqCore(args.skuId);
  const branches: StandardCatalogBranchResult[] = [];

  for (const shop of args.shops) {
    try {
      const branch = await releaseSkuToBranchCore(args.skuId, shop.id);
      if (!branch.ok || !branch.item_id || !branch.sku_id) {
        throw new Error(branch.error ?? "分店铺货后未获得真实 item_id/sku_id");
      }
      const { data: branchShop, error: branchShopError } = await supabase
        .from("youzan_shops")
        .select("*")
        .eq("id", shop.id)
        .maybeSingle();
      if (branchShopError) throw new Error(branchShopError.message);
      if (!branchShop) throw new Error("有赞分店授权记录不存在");
      const stock = await pushYouzanQuantityUpdate({
        branchShop: branchShop as unknown as Parameters<
          typeof pushYouzanQuantityUpdate
        >[0]["branchShop"],
        itemId: branch.item_id,
        skuId: branch.sku_id,
        quantity: args.targetStock,
        hqSpuIdGuard: branch.hq_spu_id ?? undefined,
        channel: 1,
      });
      const pushedAt = new Date().toISOString();
      const [listingUpdate, linkUpdate] = await Promise.all([
        supabase
          .from("sku_channel_listings")
          .update({
            last_stock: args.targetStock,
            last_stock_pushed: args.targetStock,
            last_pushed_at: pushedAt,
            last_error: null,
            updated_at: pushedAt,
          } as never)
          .eq("sku_id", args.skuId)
          .eq("channel", "youzan_branch_offline")
          .eq("shop_id", shop.id),
        supabase
          .from("sku_youzan_links")
          .update({
            last_pushed_stock: args.targetStock,
            last_pushed_at: pushedAt,
            last_error: null,
            updated_at: pushedAt,
          } as never)
          .eq("sku_id", args.skuId)
          .eq("shop_id", shop.id),
      ]);
      if (listingUpdate.error) throw new Error(listingUpdate.error.message);
      if (linkUpdate.error) throw new Error(linkUpdate.error.message);
      branches.push({
        shop_id: shop.id,
        shop_name: shop.shop_name,
        ok: true,
        branch_item_id: branch.item_id,
        branch_sku_id: branch.sku_id,
        target_stock: args.targetStock,
        trace_id: stock.trace_id,
      });
    } catch (error) {
      const failure = explainYouzanError(error).slice(0, 400);
      const failedAt = new Date().toISOString();
      await Promise.all([
        supabase
          .from("sku_youzan_links")
          .update({
            status: "error",
            sync_stock: false,
            last_error: failure,
            updated_at: failedAt,
          } as never)
          .eq("sku_id", args.skuId)
          .eq("shop_id", shop.id),
        supabase
          .from("sku_channel_listings")
          .update({
            listing_status: "error",
            last_error: failure,
            updated_at: failedAt,
          } as never)
          .eq("sku_id", args.skuId)
          .eq("channel", "youzan_branch_offline")
          .eq("shop_id", shop.id),
      ]);
      branches.push({
        shop_id: shop.id,
        shop_name: shop.shop_name,
        ok: false,
        error: failure,
      });
    }
  }

  return {
    ok: branches.every((branch) => branch.ok),
    hq,
    branches,
  };
}

export async function syncStandardSkuToAllYouzanBranchesCore(
  skuId: string,
  targetStock = 9999,
) {
  const shops = await listStandardCatalogTargetShops();
  if (shops.length === 0) throw new Error("没有可同步的启用中有赞分店");
  return syncStandardSkuToYouzanBranchesCore({ skuId, shops, targetStock });
}
