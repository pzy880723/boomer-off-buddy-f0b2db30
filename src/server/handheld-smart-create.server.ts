import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { findSanrioBrandCandidate } from "@/lib/product-classification";
import { matchBrandCandidate } from "@/lib/product-taxonomy";
import { loadActiveProductBrands, loadActiveProductIps } from "./product-classification.server";

export function getSmartCreateReleaseTarget(input: {
  autoPushYouzan: boolean;
  locationKind: string;
  shopId: string | null | undefined;
}): string | null {
  if (!input.autoPushYouzan) return null;
  if (input.locationKind !== "shop") return null;
  return input.shopId?.trim() || null;
}

export function shouldReuseSmartCreateSku(isCustomPrice: boolean): boolean {
  return !isCustomPrice;
}

export async function persistSmartCreateBrand(input: {
  skuId: string;
  brand?: string | null;
}): Promise<void> {
  if (input.brand === undefined) return;
  const brandText = input.brand?.trim() || null;
  const [brands, ips] = brandText
    ? await Promise.all([loadActiveProductBrands(), loadActiveProductIps()])
    : [[], []];
  const sanrio = findSanrioBrandCandidate(brands, ips);
  const brand = matchBrandCandidate(brandText, [...brands, ...(sanrio ? [sanrio] : [])]);

  // Read after audit attachment so changing the brand retains all other AI attributes.
  const current = await supabaseAdmin
    .from("inv_skus")
    .select("attributes")
    .eq("id", input.skuId)
    .maybeSingle();
  if (current.error || !current.data) {
    throw new Error(`读取 SKU 品牌属性失败：${current.error?.message ?? "not found"}`);
  }
  const attributes = current.data.attributes;
  const saved = await supabaseAdmin
    .from("inv_skus")
    .update({
      attributes: {
        ...(attributes && typeof attributes === "object" && !Array.isArray(attributes)
          ? attributes
          : {}),
        brand: brandText,
      },
      brand_id: brand.match?.id ?? null,
      brand_candidate_text: brand.status === "review_required" ? brand.candidate_text : null,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("id", input.skuId);
  if (saved.error) throw new Error(`保存 SKU 品牌失败：${saved.error.message}`);
}
