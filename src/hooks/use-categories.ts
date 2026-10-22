import { useQuery } from "@tanstack/react-query";
import { listCategories, type CategoryRow } from "@/lib/categories.functions";
import { INV_CATEGORIES } from "@/lib/inventory.helpers";
import { resolveCategoryLabel } from "@/lib/commerce/category-labels";

const FALLBACK: CategoryRow[] = INV_CATEGORIES.map((c, i) => ({
  id: c.value,
  code: c.value,
  name: c.label,
  parent_id: null,
  sort_order: (i + 1) * 10,
  is_active: true,
  is_system: true,
}));

export function useCategories() {
  const q = useQuery({
    queryKey: ["inv-categories"],
    queryFn: () => listCategories(),
    staleTime: 30_000,
  });
  const rows = q.data?.rows && q.data.rows.length > 0 ? q.data.rows : FALLBACK;
  const hasTree = rows.some((row) => row.parent_id !== null);
  const activeRootIds = new Set(
    rows.filter((row) => row.is_active && row.parent_id === null).map((row) => row.id),
  );
  const active = hasTree
    ? rows.filter(
        (row) => row.is_active && row.parent_id !== null && activeRootIds.has(row.parent_id),
      )
    : rows.filter((row) => row.is_active);
  // 只显示真实字典中文（含内置种子），缺失显示“未归类”，绝不把英文编码当名称。
  const dictRows = rows.map((r) => ({ id: r.id, code: r.code, name: r.name, parent_id: r.parent_id }));
  const labelOf = (code: string) => resolveCategoryLabel(code, dictRows).name ?? "未归类";
  const displayLabelOf = (code: string) => resolveCategoryLabel(code, dictRows).path.join(" / ") || "未归类";
  return {
    rows,
    active,
    labelOf,
    displayLabelOf,
    loading: q.isLoading,
    refetch: q.refetch,
  };
}
