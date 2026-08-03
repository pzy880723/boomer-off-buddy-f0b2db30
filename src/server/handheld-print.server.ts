/**
 * 标签打印 payload 构造器。
 * APP 端自渲染 ZPL / ESC-POS，所以 ERP 只回扁平字段。
 */
export type PrintPayload = {
  sku_code: string | null;
  barcode: string | null;
  title_short: string;
  price_tag: string;
  grade: string | null;
};

export function buildPrintPayload(input: {
  sku_code?: string | null;
  barcode?: string | null;
  name?: string | null;
  price_tier?: number | null;
  grade?: string | null;
  condition_grade?: string | null;
}): PrintPayload {
  const title = (input.name ?? "").trim();
  const titleShort = title.length > 24 ? `${title.slice(0, 23)}…` : title;
  const price = Number(input.price_tier ?? 0);
  const priceTag = `¥${Number.isFinite(price) ? Number(price.toFixed(2)) : 0}`;
  return {
    sku_code: input.sku_code ?? null,
    barcode: input.barcode ?? null,
    title_short: titleShort,
    price_tag: priceTag,
    grade: input.condition_grade ?? input.grade ?? null,
  };
}
