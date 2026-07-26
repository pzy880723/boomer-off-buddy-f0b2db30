import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { processYouzanSale, type YouzanSaleAdapter } from "./youzan-sale.server";

async function findSkuByCode(codes: string[]): Promise<string | null> {
  const uniqueCodes = Array.from(
    new Set(codes.map((code) => code.trim()).filter((code) => /^[A-Za-z0-9_-]+$/.test(code))),
  );
  if (uniqueCodes.length === 0) return null;
  const filters = uniqueCodes.flatMap((code) => [
    `sku_code.eq.${code}`,
    `barcode.eq.${code}`,
    `epc.eq.${code}`,
  ]);
  const { data, error } = await supabaseAdmin
    .from("inv_skus")
    .select("id")
    .or(filters.join(","))
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`按商品编码匹配库存失败：${error.message}`);
  return data?.id ?? null;
}

export function createSupabaseYouzanSaleAdapter(): YouzanSaleAdapter {
  const locationCache = new Map<string, string | null>();
  const skuCache = new Map<string, string | null>();
  return {
    async findLocationId(shopId) {
      if (locationCache.has(shopId)) return locationCache.get(shopId) ?? null;
      const { data, error } = await supabaseAdmin
        .from("inv_locations")
        .select("id")
        .eq("shop_id", shopId)
        .maybeSingle();
      if (error) throw new Error(`查询销售库位失败：${error.message}`);
      const locationId = data?.id ?? null;
      locationCache.set(shopId, locationId);
      return locationId;
    },

    async findSkuId({ shopId, itemId, remoteSkuId, lookupCodes }) {
      const cacheKey = `${shopId}:${itemId}:${remoteSkuId ?? ""}:${lookupCodes.join("|")}`;
      if (skuCache.has(cacheKey)) return skuCache.get(cacheKey) ?? null;
      let listingQuery = supabaseAdmin
        .from("sku_channel_listings")
        .select("sku_id")
        .eq("shop_id", shopId)
        .eq("external_item_id", String(itemId));
      if (remoteSkuId) {
        listingQuery = listingQuery.or(
          `external_item_id.eq.${itemId},external_sku_id.eq.${remoteSkuId}`,
        );
      }
      const { data: listing, error: listingError } = await listingQuery.limit(1).maybeSingle();
      if (listingError) throw new Error(`查询渠道商品映射失败：${listingError.message}`);
      if (listing?.sku_id) {
        skuCache.set(cacheKey, listing.sku_id);
        return listing.sku_id;
      }

      let legacyQuery = supabaseAdmin
        .from("sku_youzan_links")
        .select("sku_id")
        .eq("shop_id", shopId)
        .eq("yz_item_id", itemId);
      if (remoteSkuId) {
        legacyQuery = legacyQuery.or(`yz_item_id.eq.${itemId},yz_sku_id.eq.${remoteSkuId}`);
      }
      const { data: legacy, error: legacyError } = await legacyQuery.limit(1).maybeSingle();
      if (legacyError) throw new Error(`查询有赞商品映射失败：${legacyError.message}`);
      if (legacy?.sku_id) {
        skuCache.set(cacheKey, legacy.sku_id);
        return legacy.sku_id;
      }

      const skuId = await findSkuByCode(lookupCodes);
      skuCache.set(cacheKey, skuId);
      return skuId;
    },

    async commitSale(input) {
      const { data, error } = await supabaseAdmin.rpc("commit_sale", {
        p_sku_id: input.skuId,
        p_source_channel: input.sourceChannel,
        p_source_order_id: input.sourceOrderId,
        p_source_shop_id: input.shopId,
        p_event_type: "paid",
        p_epc: null,
        p_location_id: input.locationId,
        p_raw_payload: input.rawPayload,
      } as never);
      if (error) throw new Error(`库存扣减失败：${error.message}`);
      const result = data as {
        ok?: boolean;
        idempotent?: boolean;
        error?: string;
      } | null;
      return {
        ok: result?.ok === true,
        idempotent: result?.idempotent === true,
        error: result?.error,
      };
    },
  };
}

export async function reconcileYouzanTradeSale(input: { trade: unknown; shopId: string }) {
  return processYouzanSale({
    ...input,
    adapter: createSupabaseYouzanSaleAdapter(),
  });
}
