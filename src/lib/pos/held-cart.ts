// 挂单快照映射：POS 购物车行 <-> pos_held_cart_items 的 4 个快照字段。
// 命名与 commerce_order_items 对齐，统一使用 *_snapshot 后缀。

export type HeldCartItemSnapshot = {
  category_code: string | null;
  category_name_snapshot: string | null;
  subcategory_code: string | null;
  subcategory_name_snapshot: string | null;
};

export type CartLineCategoryFields = {
  category_code?: string | null;
  category_name?: string | null;
  subcategory_code?: string | null;
  subcategory_name?: string | null;
};

/** 挂单写入：购物车行 -> 快照字段（缺失一律 null，不造假） */
export function toHeldCartSnapshot(line: CartLineCategoryFields): HeldCartItemSnapshot {
  return {
    category_code: line.category_code ?? null,
    category_name_snapshot: line.category_name ?? null,
    subcategory_code: line.subcategory_code ?? null,
    subcategory_name_snapshot: line.subcategory_name ?? null,
  };
}

/** 取单还原：快照字段 -> 购物车行（快照优先，其次当前商品信息） */
export function fromHeldCartSnapshot(
  snapshot: Partial<HeldCartItemSnapshot>,
  fallback: CartLineCategoryFields = {},
): Required<CartLineCategoryFields> {
  return {
    category_code: snapshot.category_code ?? fallback.category_code ?? null,
    category_name: snapshot.category_name_snapshot ?? fallback.category_name ?? null,
    subcategory_code: snapshot.subcategory_code ?? fallback.subcategory_code ?? null,
    subcategory_name: snapshot.subcategory_name_snapshot ?? fallback.subcategory_name ?? null,
  };
}
