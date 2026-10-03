import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isPosBrand } from "@/lib/pos/brand-catalog";

export async function validatePosBrands(items: Array<{ brand_id?: string | null }>) {
  const ids = [...new Set(items.flatMap((item) => item.brand_id ? [item.brand_id] : []))];
  const names = new Map<string, string>();
  if (!ids.length) return { ok: true as const, names };
  const { data, error } = await supabaseAdmin.from("inv_brands")
    .select("id,name,status,entity_type").in("id", ids);
  if (error) return { ok: false as const, message: error.message, status: 500 };
  for (const brand of data ?? []) if (isPosBrand(brand)) names.set(brand.id, brand.name);
  if (names.size !== ids.length) return { ok: false as const, status: 422,
    message: "所选品牌不存在、已停用或属于角色标签，请重新选择" };
  return { ok: true as const, names };
}
