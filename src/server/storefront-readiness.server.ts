import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** DB-owned eligibility, including old rows; checked before images are signed. */
export async function filterImageReadyListings<T extends { sku_id: string }>(
  listings: T[],
  read = async (ids: string[]): Promise<string[]> => {
    const { data, error } = await supabaseAdmin.rpc("storefront_ready_skus" as never, { p_ids: ids } as never);
    if (error) throw new Error("storefront_readiness_unavailable");
    return ((data ?? []) as Array<{ sku_id: string }>).map((row) => row.sku_id);
  },
): Promise<T[]> {
  if (!listings.length) return [];
  const allowed = new Set(await read([...new Set(listings.map((row) => row.sku_id))]));
  return listings.filter((row) => allowed.has(row.sku_id));
}