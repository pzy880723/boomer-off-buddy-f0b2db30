export type PosProductType = "custom" | "standard" | "bundle";

export type PosScannableProduct = {
  sku_id: string;
  product_type: PosProductType;
  name: string;
  unit_price: number;
  available_qty: number;
};

export type PosCartLine = PosScannableProduct & {
  quantity: number;
};

export type PosTender = {
  provider: "cash" | "wechat" | "alipay" | "bank_card" | "store_credit" | "manual";
  amount: number;
  provider_transaction_id?: string;
};

export function addScannedProduct(
  cart: PosCartLine[],
  product: PosScannableProduct,
): PosCartLine[] {
  const existing = cart.find((line) => line.sku_id === product.sku_id);
  if (!existing) {
    if (product.available_qty < 1) throw new Error("product has no available stock");
    return [...cart, { ...product, quantity: 1 }];
  }
  if (product.product_type === "custom") throw new Error("custom product is already in cart");
  if (existing.quantity >= product.available_qty) {
    throw new Error("quantity exceeds available stock");
  }
  return cart.map((line) =>
    line.sku_id === product.sku_id ? { ...line, quantity: line.quantity + 1 } : line,
  );
}

function cents(value: number): number {
  return Math.round(value * 100);
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
