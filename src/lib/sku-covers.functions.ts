import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * 批量给一组 SKU 签封面 URL。
 * 输入：sku_ids[]
 * 返回：{ [skuId]: string | null }
 *
 * 优先用 inv_skus.image_paths[0]，回退到 inv_skus.image_url（外链）。
 * 私桶用 service-role 签 24 小时 URL。
 */
export const signSkuCovers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({ sku_ids: z.array(z.string().uuid()).min(0).max(500) })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    if (data.sku_ids.length === 0) return { covers: {} as Record<string, string | null> };

    const { data: rows, error } = await context.supabase
      .from("inv_skus")
      .select("id, image_paths, image_url")
      .in("id", data.sku_ids);
    if (error) throw new Error(error.message);

    const { signSkuCover } = await import("./sku-image-resolver.server");
    const covers: Record<string, string | null> = {};
    await Promise.all(
      (rows ?? []).map(async (r) => {
        const paths = ((r as { image_paths?: string[] | null }).image_paths ?? []) as string[];
        covers[r.id] = await signSkuCover(paths, r.image_url ?? null);
      }),
    );
    return { covers };
  });
