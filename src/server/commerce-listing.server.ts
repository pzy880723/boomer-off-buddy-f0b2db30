import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getPublicOrigin, resolvePublicSkuImageUrls } from "@/lib/sku-media";

export type CustomListingSyncResult =
  | { ok: true; skipped: true; reason: string }
  | { ok: true; skipped: false; listing_id: string; status: string; image_count: number }
  | { ok: false; skipped: false; error: string };

/**
 * 只有「自定义商品（custom / 唯一件）」才进 BOOMEROFF 市集。
 * standard / bundle 一律跳过，保证 400+ 标准商品永远不会被发布到商城。
 */
export async function upsertCustomListingForSku(args: {
  skuId: string;
  locationId: string;
  createdBy?: string | null;
}): Promise<CustomListingSyncResult> {
  const { data: sku, error } = await supabaseAdmin
    .from("inv_skus")
    .select(
      "id, name, kind, price_tier, is_custom_price, inventory_policy, grade, notes, category, epc, image_url, image_paths, status",
    )
    .eq("id", args.skuId)
    .maybeSingle();
  if (error) return { ok: false, skipped: false, error: error.message };
  if (!sku) return { ok: false, skipped: false, error: "SKU 不存在" };

  const row = sku as unknown as {
    id: string;
    name: string;
    kind: string | null;
    price_tier: number | null;
    is_custom_price: boolean | null;
    inventory_policy: string | null;
    grade: string | null;
    notes: string | null;
    category: string | null;
    epc: string | null;
    image_url: string | null;
    image_paths: string[] | null;
    status: string | null;
  };

  const isCustom =
    row.is_custom_price === true &&
    row.inventory_policy !== "unlimited" &&
    (row.kind ?? "single") === "single";
  if (!isCustom) {
    return { ok: true, skipped: true, reason: "非自定义商品（标准/组合品不进市集）" };
  }
  if (row.status !== "active") {
    return { ok: true, skipped: true, reason: "SKU 非 active" };
  }

  const origin = getPublicOrigin();
  const imageUrls = resolvePublicSkuImageUrls(
    [row.image_url, ...(Array.isArray(row.image_paths) ? row.image_paths : [])],
    origin,
    6,
  );

  const { data: stock } = await supabaseAdmin
    .from("inv_stocks")
    .select("qty")
    .eq("sku_id", row.id)
    .eq("location_id", args.locationId)
    .maybeSingle();
  const qty = Math.max(0, Math.trunc(Number((stock as { qty?: number } | null)?.qty ?? 0)));
  const nowIso = new Date().toISOString();
  const status = qty > 0 ? "published" : "sold";

  const { data: existing } = await supabaseAdmin
    .from("commerce_listings")
    .select("id, status, published_at")
    .eq("sku_id", row.id)
    .eq("location_id", args.locationId)
    .maybeSingle();

  const payload = {
    sku_id: row.id,
    location_id: args.locationId,
    epc: row.epc ?? null,
    title: row.name,
    description: row.notes ?? null,
    cover_url: imageUrls[0] ?? null,
    image_urls: imageUrls,
    price: Number(row.price_tier ?? 0),
    condition_grade: row.grade ?? null,
    category: row.category ?? null,
    product_type: "custom",
    status,
    published_at:
      status === "published"
        ? ((existing as { published_at?: string } | null)?.published_at ?? nowIso)
        : ((existing as { published_at?: string } | null)?.published_at ?? nowIso),
    sold_at: status === "sold" ? nowIso : null,
    created_by: args.createdBy ?? null,
    updated_at: nowIso,
  };

  const { data: upserted, error: upsertError } = await supabaseAdmin
    .from("commerce_listings")
    .upsert(payload as never, { onConflict: "sku_id,location_id" })
    .select("id, status")
    .single();
  if (upsertError || !upserted) {
    return { ok: false, skipped: false, error: upsertError?.message ?? "upsert listing failed" };
  }

  return {
    ok: true,
    skipped: false,
    listing_id: (upserted as { id: string }).id,
    status: (upserted as { status: string }).status,
    image_count: imageUrls.length,
  };
}
