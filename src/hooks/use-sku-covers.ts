import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { signSkuCovers } from "@/lib/sku-covers.functions";

/**
 * 给一组 SKU id 批量签封面图 URL。
 * - 输入 ids 变化时自动重取
 * - 返回稳定 Map 引用，配合 row.image_url 做兜底
 */
export function useSkuCovers(skuIds: string[]): {
  covers: Record<string, string | null>;
  isLoading: boolean;
} {
  const fn = useServerFn(signSkuCovers);
  const ids = useMemo(() => Array.from(new Set(skuIds)).sort(), [skuIds]);
  const key = ids.join(",");
  const q = useQuery({
    queryKey: ["sku-covers", key],
    queryFn: () => fn({ data: { sku_ids: ids } }),
    enabled: ids.length > 0,
    staleTime: 5 * 60 * 1000,
  });
  return {
    covers: q.data?.covers ?? {},
    isLoading: q.isLoading,
  };
}

/** 取单个 SKU 的封面：优先签出来的，回退 fallback http 外链 */
export function pickCover(
  signed: string | null | undefined,
  fallback: string | null | undefined,
): string | null {
  if (signed) return signed;
  if (fallback && /^https?:\/\//i.test(fallback) && !fallback.includes("token=")) return fallback;
  return null;
}
