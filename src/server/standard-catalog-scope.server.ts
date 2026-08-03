import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { inheritsGlobalStandardCatalog } from "@/lib/shop-standard-catalog";

/**
 * 某个库位（门店/仓库）是否自动继承总部全局标准商品目录。
 * - 仓库/总部：继承
 * - 门店：仅 store_format='vintage' 的门店继承，未来垂直业态门店不自动继承
 */
export async function locationInheritsStandardCatalog(locationId: string): Promise<boolean> {
  const { data: loc, error } = await supabaseAdmin
    .from("inv_locations")
    .select("kind, shop_id")
    .eq("id", locationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!loc) return false;
  const shopId = (loc as { shop_id?: string | null }).shop_id ?? null;
  if ((loc as { kind?: string }).kind !== "shop" || !shopId) return true;

  const { data: shop, error: shopError } = await supabaseAdmin
    .from("youzan_shops")
    .select("store_format")
    .eq("id", shopId)
    .maybeSingle();
  if (shopError) throw new Error(shopError.message);
  return inheritsGlobalStandardCatalog((shop as { store_format?: string } | null)?.store_format);
}

/** 无限库存标准商品（全局目录项）判定 */
export function isGlobalStandardItem(item: {
  product_type: string;
  is_unlimited_stock: boolean;
}): boolean {
  return item.product_type === "standard" && item.is_unlimited_stock;
}
