// 门店可见 SKU 集合的读取逻辑（从 listShopSkus 抽出，便于注入假 client 单测）。
//
// 修复点：原实现只解构了 data，忽略了 inv_locations / youzan_shops /
// sku_youzan_links / inv_stock_movements 四处的 error。
// - inv_locations 读失败（例如 401）时 loc 为 null，函数会返回「0 件」并且 HTTP 200，
//   把权限错误伪装成「该门店没有库位」；
// - links / movements 读失败时静默丢失来源，列表少几个 SKU，肉眼几乎发现不了。
// 现在四处读取错误都显式抛出；真正没有库位（无错误且无行）仍返回原有空结构。

import {
  GLOBAL_STANDARD_SKU_FILTER,
  inheritsGlobalStandardCatalog,
  resolveShopVisibleSkuIds,
} from "./shop-standard-catalog";

export type ReadResult<T> = { data: T | null; error: { message: string } | null };

/** 读取结果解包：有 error 一律抛出，绝不降级成空结果 */
export function unwrapRead<T>(label: string, result: ReadResult<T>): T | null {
  if (result.error) throw new Error(`${label} 读取失败：${result.error.message}`);
  return result.data ?? null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type QueryClient = { from: (table: string) => any };

export type ShopSkuSources = {
  location_id: string | null;
  store_format: string | null;
  stocks: Array<{ sku_id: string; qty: number }>;
  skuIds: string[];
};

export async function loadShopSkuIdSources(
  sb: QueryClient,
  shop_id: string,
): Promise<ShopSkuSources> {
  const [locRes, shopRes] = await Promise.all([
    sb.from("inv_locations").select("id, name").eq("shop_id", shop_id).maybeSingle(),
    sb.from("youzan_shops").select("store_format").eq("id", shop_id).maybeSingle(),
  ]);
  const loc = unwrapRead<{ id: string; name: string }>("门店库位", locRes);
  const shop = unwrapRead<{ store_format: string | null }>("门店资料", shopRes);
  const storeFormat = shop?.store_format ?? null;

  // 无错误且无行 = 真的没有映射库位，保持原有空结构
  if (!loc) return { location_id: null, store_format: storeFormat, stocks: [], skuIds: [] };

  const stocks =
    unwrapRead<Array<{ sku_id: string; qty: number }>>(
      "门店库存",
      await sb.from("inv_stocks").select("sku_id, qty").eq("location_id", loc.id),
    ) ?? [];

  const links =
    unwrapRead<Array<{ sku_id: string }>>(
      "门店有赞映射",
      await sb.from("sku_youzan_links").select("sku_id").eq("shop_id", shop_id),
    ) ?? [];

  const moves =
    unwrapRead<Array<{ sku_id: string }>>(
      "门店库存流水",
      await sb.from("inv_stock_movements").select("sku_id").eq("location_id", loc.id).limit(5000),
    ) ?? [];

  let globalStandardSkuIds: string[] = [];
  if (inheritsGlobalStandardCatalog(storeFormat)) {
    const standardSkus =
      unwrapRead<Array<{ id: string }>>(
        "全局标准商品",
        await sb
          .from("inv_skus")
          .select("id")
          .eq("kind", GLOBAL_STANDARD_SKU_FILTER.kind)
          .eq("is_custom_price", GLOBAL_STANDARD_SKU_FILTER.is_custom_price)
          .eq("inventory_policy", GLOBAL_STANDARD_SKU_FILTER.inventory_policy)
          .eq("is_display", GLOBAL_STANDARD_SKU_FILTER.is_display)
          .eq("status", GLOBAL_STANDARD_SKU_FILTER.status)
          .limit(5000),
      ) ?? [];
    globalStandardSkuIds = standardSkus.map((sku) => String(sku.id));
  }

  const skuIds = resolveShopVisibleSkuIds({
    storeFormat,
    stockSkuIds: stocks.map((s) => String(s.sku_id)),
    linkSkuIds: links.map((l) => String(l.sku_id)),
    movementSkuIds: moves.map((m) => String(m.sku_id)),
    globalStandardSkuIds,
  });

  return { location_id: loc.id, store_format: storeFormat, stocks, skuIds };
}
