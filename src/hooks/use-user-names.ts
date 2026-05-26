import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import { getUsersByIds } from "@/lib/mobile.functions";

/**
 * 批量解析 user_id -> 显示名（昵称或邮箱前缀）。
 * 传入的 id 列表会去重 + 排序后作为 queryKey，跨组件共享缓存。
 */
export function useUserNames(ids: Array<string | null | undefined>) {
  const fetchFn = useServerFn(getUsersByIds);
  const uniq = useMemo(() => {
    const set = new Set<string>();
    for (const id of ids) if (id) set.add(id);
    return Array.from(set).sort();
  }, [ids]);

  const q = useQuery({
    queryKey: ["user-names", uniq],
    queryFn: () => fetchFn({ data: { ids: uniq } }),
    enabled: uniq.length > 0,
    staleTime: 5 * 60_000,
  });

  const map = q.data?.users ?? {};
  return {
    /** 短名：昵称、邮箱前缀，或 uuid 末 6 位 */
    name(id: string | null | undefined): string {
      if (!id) return "—";
      return map[id]?.name ?? id.slice(-6);
    },
    raw: map,
    loading: q.isLoading,
  };
}
