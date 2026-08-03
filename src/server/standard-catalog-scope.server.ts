import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { inheritsGlobalStandardCatalog } from "@/lib/shop-standard-catalog";

export async function locationInheritsStandardCatalog(locationId: string): Promise<boolean> {
  const { data: location, error } = await supabaseAdmin
    .from("inv_locations")
    .select("kind, shop_id")
    .eq("id", locationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!location) return false;

  const shopId = (location as { shop_id?: string | null }).shop_id ?? null;
  if ((location as { kind?: string }).kind !== "shop" || !shopId) return true;

  const { data: shop, error: shopError } = await supabaseAdmin
    .from("youzan_shops")
    .select("store_format")
    .eq("id", shopId)
    .maybeSingle();
  if (shopError) throw new Error(shopError.message);
  return inheritsGlobalStandardCatalog((shop as { store_format?: string } | null)?.store_format);
}

export function isGlobalStandardItem(item: {
  product_type: string;
  is_unlimited_stock: boolean;
}): boolean {
  return item.product_type === "standard" && item.is_unlimited_stock;
}
