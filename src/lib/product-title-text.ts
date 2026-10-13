// Shared cleanup for handheld automatic product names (quick title + full recognition).
// Only for AI-generated names; never apply to ERP, migrated or user-edited names.
export const AUTO_PRODUCT_TITLE_MAX = 24;
const UNSUPPORTED_RARITY = /(?:限定|绝版|收藏级|稀有|限量|保真|升值)/gu;

export function normalizeAutoProductTitle(input: unknown): string {
  if (typeof input !== "string") return "";
  const cleaned = input.replace(UNSUPPORTED_RARITY, "").replace(/\s+/gu, " ").trim();
  return Array.from(cleaned).slice(0, AUTO_PRODUCT_TITLE_MAX).join("").trim();
}
