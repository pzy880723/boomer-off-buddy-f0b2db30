/**
 * 跨项目门店编号契约（唯一真源在 ERP 的 go_shop_location_links）。
 *
 * ERP 下发给 GO 的规范结构：
 *   shops: [{ go_shop_id, erp_location_id, name }]
 * 只从显式 active 映射翻译；缺映射即"未配置"，绝不按门店名/电话猜绑定。
 */

export type GoShopLinkRow = { go_shop_id: string; location_id: string; status: string };
export type ErpShopRow = { id: string; name: string };
export type GoShopDirectoryEntry = { go_shop_id: string; erp_location_id: string; name: string };

export function buildShopDirectory(input: {
  links: GoShopLinkRow[];
  activeShops: ErpShopRow[];
}): GoShopDirectoryEntry[] {
  const names = new Map(input.activeShops.map((s) => [s.id, s.name]));
  return input.links
    .filter((l) => l.status === "active" && names.has(l.location_id))
    .map((l) => ({
      go_shop_id: l.go_shop_id,
      erp_location_id: l.location_id,
      name: names.get(l.location_id) as string,
    }))
    .sort((a, b) => a.go_shop_id.localeCompare(b.go_shop_id));
}
