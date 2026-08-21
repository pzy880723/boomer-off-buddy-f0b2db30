import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import {
  selectStandardCatalogTargetShops,
  type StandardCatalogTargetShop,
} from "./standard-catalog-youzan-sync";
import { syncStandardGroupContainingSkuCore } from "./standard-catalog-youzan-group.server";

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
  return syncStandardGroupContainingSkuCore(args);
}

export async function syncStandardSkuToAllYouzanBranchesCore(
  skuId: string,
  targetStock = 9999,
) {
  const shops = await listStandardCatalogTargetShops();
  if (shops.length === 0) throw new Error("没有可同步的启用中有赞分店");
  return syncStandardSkuToYouzanBranchesCore({ skuId, shops, targetStock });
}
