// 与有赞连锁零售商品状态语义对齐：
// - 存储 inv_skus.is_display (bool)
// - 对外派生 listing_status: selling | sold_out | in_warehouse
export type ListingStatus = "selling" | "sold_out" | "in_warehouse";

export function deriveListingStatus(
  isDisplay: boolean | null | undefined,
  totalQty: number,
): ListingStatus {
  if (isDisplay === false) return "in_warehouse";
  return totalQty > 0 ? "selling" : "sold_out";
}

export const LISTING_STATUS_LABEL: Record<ListingStatus, string> = {
  selling: "销售中",
  sold_out: "已售罄",
  in_warehouse: "仓库中",
};

export function statusLabel(s: ListingStatus): string {
  return LISTING_STATUS_LABEL[s];
}
