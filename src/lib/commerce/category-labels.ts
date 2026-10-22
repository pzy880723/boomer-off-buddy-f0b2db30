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

/** 用已读取的字典覆盖条目分类中文；字典未命中时保留已有（种子）中文。 */
export function applyCategoryLabels<T extends { category: string | null; category_name: string | null; category_path: string[] }>(
  items: readonly T[], rows: readonly CategoryDictRow[],
): T[] {
  return items.map((item) => {
    const label = resolveCategoryLabel(item.category, rows);
    return label.name ? { ...item, category_name: label.name, category_path: label.path } : { ...item };
  });
}
