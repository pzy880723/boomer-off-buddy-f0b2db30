export type PosProductType = "custom" | "standard" | "bundle";

export type PosScannableProduct = {
  sku_id: string;
  product_type: PosProductType;
  name: string;
  unit_price: number;
  available_qty: number;
  is_unlimited_stock?: boolean;
  /** 一级类目（标准商品必填，扫码商品沿用 SKU 类目） */
  category_code?: string | null;
  category_name?: string | null;
  /** 二级类目：POS 可选分析字段，允许为空 */
  subcategory_code?: string | null;
  subcategory_name?: string | null;
};

export type PosCartLine = PosScannableProduct & {
  quantity: number;
};

export type PosTender = {
  provider: "cash" | "wechat" | "alipay" | "bank_card" | "store_credit" | "manual";
  amount: number;
  provider_transaction_id?: string;
};

export type PosDiscountType = "amount" | "percentage" | "final_price";

export type PosDiscountInput = {
  type: PosDiscountType;
  value: number;
};

export type PosDiscountLine = {
  sku_id: string;
  quantity: number;
  unit_price: number;
  discount_eligible: boolean;
};

/**
 * 购物车合并键：同 sku_id + 同二级类目才合并；
 * 同 sku_id 但二级类目不同（含 null 对非 null）必须分行。
 */
export function posCartLineKey(product: {
  sku_id: string;
  subcategory_code?: string | null;
}): string {
  return `${product.sku_id}::${product.subcategory_code ?? ""}`;
}

/** 展示名：未选二级类目为「欧洲瓷器」，已选为「欧洲瓷器 · 散瓷杯碟」 */
export function posCartLineLabel(line: {
  name: string;
  subcategory_name?: string | null;
}): string {
  return line.subcategory_name ? `${line.name} · ${line.subcategory_name}` : line.name;
}

export function addScannedProduct(
  cart: PosCartLine[],
  product: PosScannableProduct,
): PosCartLine[] {
  const key = posCartLineKey(product);
  const existing = cart.find((line) => posCartLineKey(line) === key);
  if (!existing) {
    if (!product.is_unlimited_stock && product.available_qty < 1) {
      throw new Error("product has no available stock");
    }
    return [...cart, { ...product, quantity: 1 }];
  }
  if (product.product_type === "custom") throw new Error("custom product is already in cart");
  if (!product.is_unlimited_stock) {
    const sameSkuQty = cart
      .filter((line) => line.sku_id === product.sku_id)
      .reduce((sum, line) => sum + line.quantity, 0);
    if (sameSkuQty >= product.available_qty) {
      throw new Error("quantity exceeds available stock");
    }
  }
  return cart.map((line) =>
    posCartLineKey(line) === key ? { ...line, quantity: line.quantity + 1 } : line,
  );
}


function cents(value: number): number {
  return Math.round(value * 100);
}

export function calculatePosDiscount(lines: PosDiscountLine[], discount: PosDiscountInput) {
  if (lines.length === 0) throw new Error("discount requires at least one item");
  if (!Number.isFinite(discount.value) || discount.value < 0) {
    throw new Error("discount value is invalid");
  }

  const subtotalCents = lines.reduce(
    (sum, line) => sum + cents(line.unit_price) * line.quantity,
    0,
  );
  const eligibleCents = lines.reduce(
    (sum, line) => (line.discount_eligible ? sum + cents(line.unit_price) * line.quantity : sum),
    0,
  );
  const excludedCents = subtotalCents - eligibleCents;
  let discountCents = 0;

  if (discount.type === "amount") {
    discountCents = cents(discount.value);
  } else if (discount.type === "percentage") {
    if (discount.value < 0 || discount.value > 100) {
      throw new Error("percentage discount is invalid");
    }
    discountCents = Math.round(eligibleCents * (1 - discount.value / 100));
  } else {
    const finalCents = cents(discount.value);
    if (finalCents < excludedCents || finalCents > subtotalCents) {
      throw new Error("final price exceeds eligible discount range");
    }
    discountCents = subtotalCents - finalCents;
  }

  if (discountCents > eligibleCents) {
    throw new Error("discount exceeds eligible amount");
  }

  return {
    subtotal: subtotalCents / 100,
    eligible_total: eligibleCents / 100,
    excluded_total: excludedCents / 100,
    discount_total: discountCents / 100,
    payable_total: (subtotalCents - discountCents) / 100,
  };
}

export function validatePosTenders(total: number, tenders: PosTender[]): PosTender[] {
  if (!Number.isFinite(total) || total <= 0) throw new Error("sale total is invalid");
  if (tenders.length === 0) throw new Error("at least one tender is required");
  for (const tender of tenders) {
    if (!Number.isFinite(tender.amount) || tender.amount <= 0) {
      throw new Error("tender amount is invalid");
    }
    if (tender.provider !== "cash" && !tender.provider_transaction_id?.trim()) {
      throw new Error("non-cash tender requires provider transaction id");
    }
  }
  if (tenders.reduce((sum, tender) => sum + cents(tender.amount), 0) !== cents(total)) {
    throw new Error("tender total must match sale total");
  }
  return tenders;
}
