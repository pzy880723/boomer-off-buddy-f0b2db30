import { supabaseAdmin } from "../integrations/supabase/client.server";

export type StorefrontProductQuery = {
  q: string | null;
  primary_category: string | null;
  brand_ids: string[];
  facet_codes: string[];
  location_id: string | null;
  sort: "newest" | "price_asc" | "price_desc" | "relevance";
  page: number;
  page_size: number;
};

export type StorefrontListing = {
  id: string;
  sku_id: string;
  location_id: string | null;
  title: string;
  description: string | null;
  cover_url: string | null;
  image_urls: string[] | null;
  price: number;
  compare_at_price: number | null;
  condition_grade: string | null;
  product_type: "custom" | "standard" | "bundle";
  published_at: string | null;
  location: { id: string; name: string; kind: string } | null;
};

type StorefrontSku = {
  id: string;
  category: string | null;
  keywords: string[] | null;
  stock_qty: number | null;
};

type StorefrontBrand = {
  id: string;
  name: string;
  name_original: string | null;
  logo_url: string | null;
};

type StorefrontFacet = {
  dimension: string;
  code: string;
  name: string;
  confidence: number | null;
};

function collectList(params: URLSearchParams, key: string): string[] {
  return [
    ...new Set(
      params
        .getAll(key)
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function positiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function parseStorefrontProductQuery(url: URL): StorefrontProductQuery {
  const sortValue = url.searchParams.get("sort");
  const sort = ["newest", "price_asc", "price_desc", "relevance"].includes(sortValue ?? "")
    ? (sortValue as StorefrontProductQuery["sort"])
    : url.searchParams.get("q")
      ? "relevance"
      : "newest";
  return {
    q: url.searchParams.get("q")?.trim() || null,
    primary_category:
      url.searchParams.get("primary_category")?.trim() ||
      url.searchParams.get("category")?.trim() ||
      null,
    brand_ids: collectList(url.searchParams, "brand_ids"),
    facet_codes: collectList(url.searchParams, "facet_codes"),
    location_id: url.searchParams.get("location_id")?.trim() || null,
    sort,
    page: positiveInt(url.searchParams.get("page"), 1, 100000),
    page_size: positiveInt(url.searchParams.get("page_size"), 20, 50),
  };
}

export function buildStorefrontProduct(input: {
  listing: StorefrontListing;
  sku: StorefrontSku;
  category: { code: string; name: string; parent_name: string | null } | null;
  brand: StorefrontBrand | null;
  facets: StorefrontFacet[];
  availableQty: number;
}) {
  const { listing, sku, category, brand, facets, availableQty } = input;
  const categoryCode = category?.code ?? sku.category ?? "uncategorized";
  const categoryName = category?.name ?? "待归类";
  return {
    id: listing.id,
    sku_id: listing.sku_id,
    name: listing.title,
    description: listing.description,
    primary_category: {
      code: categoryCode,
      name: categoryName,
      path: category?.parent_name ? [category.parent_name, categoryName] : [categoryName],
    },
    brand,
    facets,
    keywords: sku.keywords ?? [],
    price: Number(listing.price) || 0,
    compare_at_price: listing.compare_at_price == null ? null : Number(listing.compare_at_price),
    image_url: listing.cover_url,
    image_urls: listing.image_urls ?? [],
    product_type: listing.product_type,
    available_qty: Math.max(0, Number(availableQty) || 0),
    stock: Math.max(0, Number(availableQty) || 0),
    condition_grade: listing.condition_grade,
    location: listing.location,
    published_at: listing.published_at,
  };
}

export async function enrichStorefrontListings(listings: StorefrontListing[]) {
  const skuIds = [...new Set(listings.map((listing) => listing.sku_id).filter(Boolean))];
  if (skuIds.length === 0) return [];

  const [skuResult, facetResult, availabilityResult] = await Promise.all([
    supabaseAdmin
      .from("inv_skus")
      .select("id, category, brand_id, keywords, stock_qty")
      .in("id", skuIds),
    supabaseAdmin
      .from("inv_sku_facets" as never)
      .select("sku_id, confidence, facet:inv_facets(code, name, dimension)")
      .in("sku_id", skuIds),
    supabaseAdmin.rpc(
      "commerce_listing_availability" as never,
      {
        p_listing_ids: listings.map((listing) => listing.id),
      } as never,
    ),
  ]);
  if (skuResult.error) throw new Error(skuResult.error.message);
  if (facetResult.error) throw new Error(facetResult.error.message);
  if (availabilityResult.error) throw new Error(availabilityResult.error.message);

  const skus = (skuResult.data ?? []) as unknown as Array<
    StorefrontSku & { brand_id: string | null }
  >;
  const categoryCodes = [...new Set(skus.map((sku) => sku.category).filter(Boolean))] as string[];
  const brandIds = [...new Set(skus.map((sku) => sku.brand_id).filter(Boolean))] as string[];
  const [categoryResult, brandResult] = await Promise.all([
    categoryCodes.length
      ? supabaseAdmin
          .from("inv_categories" as never)
          .select("id, code, name, parent_id")
          .in("code", categoryCodes)
      : Promise.resolve({ data: [], error: null }),
    brandIds.length
      ? supabaseAdmin
          .from("inv_brands" as never)
          .select("id, name, name_original, logo_url")
          .in("id", brandIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (categoryResult.error) throw new Error(categoryResult.error.message);
  if (brandResult.error) throw new Error(brandResult.error.message);

  const categoryRows = (categoryResult.data ?? []) as unknown as Array<{
    id: string;
    code: string;
    name: string;
    parent_id: string | null;
  }>;
  const parentIds = [
    ...new Set(categoryRows.map((row) => row.parent_id).filter(Boolean)),
  ] as string[];
  const parentResult = parentIds.length
    ? await supabaseAdmin
        .from("inv_categories" as never)
        .select("id, name")
        .in("id", parentIds)
    : { data: [], error: null };
  if (parentResult.error) throw new Error(parentResult.error.message);

  const parentNames = new Map(
    ((parentResult.data ?? []) as unknown as Array<{ id: string; name: string }>).map((row) => [
      row.id,
      row.name,
    ]),
  );
  const categories = new Map(
    categoryRows.map((row) => [
      row.code,
      {
        code: row.code,
        name: row.name,
        parent_name: row.parent_id ? (parentNames.get(row.parent_id) ?? null) : null,
      },
    ]),
  );
  const brands = new Map(
    ((brandResult.data ?? []) as unknown as StorefrontBrand[]).map((row) => [row.id, row]),
  );
  const skuMap = new Map(skus.map((row) => [row.id, row]));
  const availability = new Map(
    (
      (availabilityResult.data ?? []) as unknown as Array<{
        listing_id: string;
        available_qty: number;
      }>
    ).map((row) => [row.listing_id, Number(row.available_qty) || 0]),
  );
  const facets = new Map<string, StorefrontFacet[]>();
  for (const relation of (facetResult.data ?? []) as unknown as Array<{
    sku_id: string;
    confidence: number | null;
    facet: { code: string; name: string; dimension: string } | null;
  }>) {
    if (!relation.facet) continue;
    facets.set(relation.sku_id, [
      ...(facets.get(relation.sku_id) ?? []),
      { ...relation.facet, confidence: relation.confidence },
    ]);
  }

  return listings.flatMap((listing) => {
    const sku = skuMap.get(listing.sku_id);
    if (!sku) return [];
    return [
      buildStorefrontProduct({
        listing,
        sku,
        category: sku.category ? (categories.get(sku.category) ?? null) : null,
        brand: sku.brand_id ? (brands.get(sku.brand_id) ?? null) : null,
        facets: facets.get(sku.id) ?? [],
        availableQty: availability.get(listing.id) ?? 0,
      }),
    ];
  });
}
