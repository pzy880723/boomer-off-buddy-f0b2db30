import { useQuery } from "@tanstack/react-query";
import { listCategories, type CategoryRow } from "@/lib/categories.functions";
import { INV_CATEGORIES, CATEGORY_LABEL as SEED_LABEL } from "@/lib/inventory.helpers";

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
  const byId = new Map(rows.map((row) => [row.id, row]));
  const labelOf = (code: string) =>
    rows.find((r) => r.code === code)?.name ?? SEED_LABEL[code] ?? code;
  const displayLabelOf = (code: string) => {
    const row = rows.find((item) => item.code === code);
    if (!row) return SEED_LABEL[code] ?? code;
    const parent = row.parent_id ? byId.get(row.parent_id) : null;
    return parent ? `${parent.name} / ${row.name}` : row.name;
  };
  return {
    rows,
    active,
    labelOf,
    displayLabelOf,
    loading: q.isLoading,
    refetch: q.refetch,
  };
}
