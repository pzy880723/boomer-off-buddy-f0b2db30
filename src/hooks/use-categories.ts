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
  youzan_hq_category_id: null,
  youzan_shop_id: null,
  synced_at: null,
}));

export function useCategories() {
  const q = useQuery({
    queryKey: ["inv-categories"],
    queryFn: () => listCategories(),
    staleTime: 30_000,
  });
  const rows = q.data?.rows && q.data.rows.length > 0 ? q.data.rows : FALLBACK;
  const active = rows.filter((r) => r.is_active);
  const labelOf = (code: string) =>
    rows.find((r) => r.code === code)?.name ?? SEED_LABEL[code] ?? code;
  return { rows, active, labelOf, loading: q.isLoading, refetch: q.refetch };
}
