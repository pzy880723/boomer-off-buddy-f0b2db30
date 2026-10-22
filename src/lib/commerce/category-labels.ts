// 分类中文显示：只用真实分类字典（inv_categories，缺失时退回内置种子中文），绝不把编码当中文名。
import { CATEGORY_LABEL } from "../inventory.helpers.ts";

export type CategoryDictRow = { id: string; code: string; name: string; parent_id: string | null };
export type CategoryLabel = { name: string | null; path: string[] };

export function resolveCategoryLabel(code: string | null | undefined, rows: readonly CategoryDictRow[]): CategoryLabel {
  if (!code) return { name: null, path: [] };
  const row = rows.find((r) => r.code === code);
  if (row?.name && row.name !== code) {
    const parent = row.parent_id ? rows.find((r) => r.id === row.parent_id) : undefined;
    return { name: row.name, path: parent?.name ? [parent.name, row.name] : [row.name] };
  }
  const seed = (CATEGORY_LABEL as Record<string, string>)[code];
  return seed ? { name: seed, path: [seed] } : { name: null, path: [] };
}
