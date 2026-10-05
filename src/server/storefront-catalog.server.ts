import { supabaseAdmin } from "../integrations/supabase/client.server";
import { enrichStorefrontListings, loadStorefrontCategories, storefrontBatches, type StorefrontListing } from "./storefront-products.server";
import { collectStorefrontPages, createStorefrontScopeCache } from "./storefront-filters";

/** Shared list/filter metadata only. Checkout always revalidates actual stock independently. */
export const loadStorefrontCatalog = createStorefrontScopeCache(async (scope) => {
  // search_inv_skus returns every SKU with rank 1 when both terms are null.
  // Start from the much smaller published catalog in that case; enrichment still
  // enforces active/display SKU state and the same store-specific stock RPC.
  const directPublished = !scope.q && !scope.primary_category;
  const ranked = directPublished ? [] : await collectStorefrontPages(async (offset, limit) => {
    const { data, error } = await supabaseAdmin.rpc("search_inv_skus" as never, {
      p_query: scope.q,
      p_primary_category: scope.primary_category,
      p_brand_ids: [],
      p_facet_codes: [],
      p_limit: limit,
      p_offset: offset,
    } as never);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as Array<{ sku_id: string; search_rank: number }>;
  });
  const skuIds = [...new Set(ranked.map(row => row.sku_id))];
  const skuBatches: Array<string[] | null> = directPublished ? [null] : storefrontBatches(skuIds);
  const [batches, categoryRows] = await Promise.all([Promise.all(skuBatches.map(batch => collectStorefrontPages(async (offset, limit) => {
    let db = supabaseAdmin.from("commerce_listings" as never).select(
      "id, sku_id, location_id, title, description, cover_url, image_urls, image_paths, price, compare_at_price, condition_grade, product_type, published_at, location:inv_locations!location_id(id,name,kind),sku:inv_skus!sku_id(id,category,status,is_display,brand_id,keywords,stock_qty,brand:inv_brands!inv_skus_brand_id_fkey(id,name,name_original,logo_url),facet_links:inv_sku_facets!inv_sku_facets_sku_id_fkey(confidence,facet:inv_facets!inv_sku_facets_facet_id_fkey(code,name,dimension)),image_jobs:inv_listing_image_jobs(status,source_bucket,source_path,target_path,updated_at))",
    ).eq("status", "published").order("id", { ascending: true }).range(offset, offset + limit - 1);
    if (batch) db = db.in("sku_id", batch);
    if (scope.location_id) db = db.eq("location_id", scope.location_id);
    const { data, error } = await db;
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as StorefrontListing[];
  }))), loadStorefrontCategories()]);
  const listings = batches.flat();
  const products = (await enrichStorefrontListings(listings, { signImages: false, useListingMetadata: true, categoryMetadata: Promise.resolve(categoryRows) })).filter(product => product.stock > 0);
  const rank = directPublished ? new Map(listings.map(row => [row.sku_id, 1])) : new Map(ranked.map(row => [row.sku_id, row.search_rank]));
  return { products, listingsById: new Map(listings.map(listing => [listing.id, listing])), rank };
});
