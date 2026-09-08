// 公开门店清单（只读）。
// 数据源：youzan_shops（门店主档） + inv_locations（kind='shop' 的库位，其 id 即商品接口的 location_id）。
// 严格字段白名单：不返回 manager / phone / token / kdt_id 等内部或联系人字段。
// 门头图桶 shop-images 保持私有，只签短期 URL；签名失败或无图一律返回 null。

const SHOP_IMAGE_BUCKET = "shop-images";
export const SHOP_IMAGE_TTL = 300; // 5 分钟短期签名

export type ShopSourceRow = {
  id: string;
  shop_name: string | null;
  status: string | null;
  address: string | null;
  image_url: string | null;
  location: { id: string; name: string | null; kind: string | null; is_active: boolean } | null;
};

export type PublicShop = {
  id: string;
  shop_id: string;
  name: string;
  city: string | null;
  address: string | null;
  image_url: string | null;
  business_hours: null;
  latitude: null;
  longitude: null;
};

/**
 * 仅从明确的中国大陆地址前缀解析城市（省/直辖市 + 市）。无法确定时返回 null，绝不猜测。
 */
export function parseCityFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const s = String(address).trim();
  if (!s) return null;
  const municipality = s.match(/^(北京|上海|天津|重庆)市/);
  if (municipality) return `${municipality[1]}市`;
  const city = s.match(/^[^省]{2,10}省\s*([^\s市]{2,10}市)/);
  if (city) return city[1];
  const bare = s.match(/^([^\s市省]{2,10}市)/);
  if (bare) return bare[1];
  return null;
}

/** 只保留可经营门店：门店主档 active + 对应库位 active 且 kind='shop'（排除仓库等库位）。 */
export function isPublicShopRow(row: ShopSourceRow): boolean {
  if (row.status !== "active") return false;
  const loc = row.location;
  if (!loc || !loc.id) return false;
  if (loc.kind !== "shop") return false;
  return loc.is_active === true;
}

/** 字段白名单映射；image_url 由调用方注入签名结果（缺图/失败为 null）。 */
export function toPublicShop(row: ShopSourceRow, signedImageUrl: string | null): PublicShop {
  return {
    id: row.location!.id,
    shop_id: row.id,
    name: (row.shop_name ?? row.location?.name ?? "").trim(),
    city: parseCityFromAddress(row.address),
    address: row.address ?? null,
    image_url: signedImageUrl,
    business_hours: null,
    latitude: null,
    longitude: null,
  };
}

export type ShopImageSigner = (paths: readonly string[]) => Promise<(string | null)[]>;

export async function buildPublicShops(
  rows: ShopSourceRow[],
  signer: ShopImageSigner,
): Promise<PublicShop[]> {
  const visible = rows.filter(isPublicShopRow);
  const slots = visible
    .map((row, idx) => ({ idx, path: (row.image_url ?? "").trim() }))
    .filter((slot) => slot.path.length > 0);

  const signed = new Map<number, string>();
  if (slots.length > 0) {
    let results: (string | null)[] = [];
    try {
      results = await signer(slots.map((slot) => slot.path));
    } catch {
      results = [];
    }
    slots.forEach((slot, i) => {
      const url = results[i];
      if (url) signed.set(slot.idx, url);
    });
  }

  return visible
    .map((row, idx) => toPublicShop(row, signed.get(idx) ?? null))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

/** 生产签名器：service-role 对私桶批量签短期 URL；失败返回 null，不抛。 */
export async function signShopImages(paths: readonly string[]): Promise<(string | null)[]> {
  if (paths.length === 0) return [];
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.storage
    .from(SHOP_IMAGE_BUCKET)
    .createSignedUrls(paths as string[], SHOP_IMAGE_TTL);
  if (error || !data) return paths.map(() => null);
  return data.map((row) => row?.signedUrl ?? null);
}
