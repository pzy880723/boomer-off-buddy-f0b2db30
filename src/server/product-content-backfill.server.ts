import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadAutoContentInput } from "@/server/listing-readiness.server";
import type { BackfillDb, LoadInput } from "@/server/product-content-backfill";

/** 真实 DB 适配：service role，只读 + 调用 product_content_backfill_* 函数。 */
export const backfillDb: BackfillDb = {
  async rpc(name, args) {
    const r = await supabaseAdmin.rpc(name as never, args as never);
    return { data: r.data, error: r.error ? { message: r.error.message } : null };
  },
  async listPublishedSkuIds(after, limit) {
    let q = supabaseAdmin.from("commerce_listings").select("sku_id").eq("status", "published")
      .order("sku_id", { ascending: true }).limit(limit * 4);
    if (after) q = q.gt("sku_id", after);
    const { data, error } = await q;
    if (error) throw new Error("list_published_failed");
    return [...new Set(((data ?? []) as Array<{ sku_id: string }>).map((r) => r.sku_id))].slice(0, limit);
  },
  async contentRow(skuId) {
    const { data, error } = await supabaseAdmin.from("inv_product_content")
      .select("version, published_blocks, draft_blocks").eq("sku_id", skuId).maybeSingle();
    if (error) throw new Error("content_read_failed");
    return (data as { version: number; published_blocks: unknown; draft_blocks: unknown } | null) ?? null;
  },
};

export const loadBackfillInput: LoadInput = loadAutoContentInput;
