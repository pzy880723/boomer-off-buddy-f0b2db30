import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function requireHq(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.from("user_roles").select("role").eq("user_id", context.userId);
  if (error) throw new Error("服务暂时不可用，请稍后再试");
  const roles = ((data as { role: string }[] | null) ?? []).map((r) => r.role);
  if (!roles.includes("super_admin") && !roles.includes("hq_operator")) throw new Error("仅总部可查看上架准备");
}

export type ReadinessRow = {
  sku_id: string;
  sku_code: string | null;
  name: string;
  input_revision: number;
  recognition_status: string;
  image_status: string;
  content_status: string;
  content_mode: string | null;
  last_error: string | null;
  held_listings: number;
  updated_at: string;
};

export const listListingReadiness = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ReadinessRow[]> => {
    await requireHq(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("listing_readiness" as never)
      .select("sku_id,input_revision,recognition_status,image_status,content_status,content_mode,last_error,updated_at,sku:inv_skus!sku_id(sku_code,name)")
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error) throw new Error("服务暂时不可用，请稍后再试");
    const rows = (data ?? []) as unknown as Array<Omit<ReadinessRow, "sku_code" | "name" | "held_listings"> & { sku: { sku_code: string | null; name: string } | null }>;
    const ids = rows.map((r) => r.sku_id);
    const held = ids.length
      ? await supabaseAdmin.from("commerce_listings").select("sku_id").in("sku_id", ids).eq("readiness_hold" as never, true as never)
      : { data: [], error: null };
    const heldCount = new Map<string, number>();
    for (const h of (held.data ?? []) as Array<{ sku_id: string }>) heldCount.set(h.sku_id, (heldCount.get(h.sku_id) ?? 0) + 1);
    return rows.map(({ sku, ...r }) => ({ ...r, sku_code: sku?.sku_code ?? null, name: sku?.name ?? "", held_listings: heldCount.get(r.sku_id) ?? 0 }));
  });

export const retryListingReadiness = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ sku_id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    await requireHq(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const retry = await supabaseAdmin.rpc("listing_readiness_retry" as never, { p_sku: data.sku_id } as never);
    if (retry.error) throw new Error("重试失败，请稍后再试");
    const { triggerListingImageWorker } = await import("@/server/handheld-listing-image-jobs.server");
    const { advanceListingReadiness } = await import("@/server/listing-readiness.server");
    const requeued = Number((retry.data as { requeued_images?: number } | null)?.requeued_images ?? 0);
    if (requeued > 0) triggerListingImageWorker(requeued);
    const outcome = await advanceListingReadiness(data.sku_id).catch(() => ({ status: "error" }));
    return { requeued_images: requeued, outcome };
  });
