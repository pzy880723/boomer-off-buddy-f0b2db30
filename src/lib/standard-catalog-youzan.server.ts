import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import { publishSkuToHqCore } from "./omnichannel-publish.functions";
import {
  selectStandardCatalogTargetShops,
  type StandardCatalogTargetShop,
} from "./standard-catalog-youzan-sync";
import { releaseSkuToOfflineShopsCore } from "./youzan-offline-products.functions";

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
  const released = await releaseSkuToOfflineShopsCore({
    sku_id: args.skuId,
    shop_ids: args.shops.map((shop) => shop.id),
    stock_override: args.targetStock,
  });
  const shopNames = new Map(args.shops.map((shop) => [shop.id, shop.shop_name]));
  const branches: StandardCatalogBranchResult[] = released.results.map((branch) => ({
    shop_id: branch.shop_id,
    shop_name: shopNames.get(branch.shop_id) ?? branch.shop_id,
    ok: branch.ok,
    ...(branch.item_id ? { branch_item_id: branch.item_id } : {}),
    ...(branch.sku_id ? { branch_sku_id: branch.sku_id } : {}),
    ...(branch.ok ? { target_stock: args.targetStock } : {}),
    ...(branch.error ? { error: branch.error } : {}),
  }));

  return {
    ok: released.ok && branches.every((branch) => branch.ok),
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
