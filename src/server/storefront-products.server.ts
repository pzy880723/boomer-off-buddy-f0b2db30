import { supabaseAdmin } from "../integrations/supabase/client.server";
import { signSkuImagePaths } from "../lib/sku-image-resolver.server";
import { signDerivativeUrls } from "./media-derivative.server";
import { resolveListingImageSources } from "./listing-image-source";
import { collectStorefrontPages } from "./storefront-filters";
import { tencentDerivative, loadTencentMediaManifest } from "./storefront-tencent-media.server";

export type StorefrontProductQuery = {
  q: string | null;
  primary_category: string | null;
  brand_ids: string[];
  facet_codes: string[];
  location_id: string | null;
  min_price: number | null;
  max_price: number | null;
  condition_grades: string[];
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
  image_paths: string[] | null;
  price: number;
  compare_at_price: number | null;
  condition_grade: string | null;
  product_type: "custom" | "standard" | "bundle";
  published_at: string | null;
  location: { id: string; name: string; kind: string } | null;
  sku?: {image_jobs: Array<{status: string; source_bucket: string; source_path: string; target_path: string | null; updated_at: string}>} & Partial<StorefrontJoinedSku> | null;
};

export type ImageSigner = (paths: readonly string[]) => Promise<(string | null)[]>;

export async function resolveStorefrontListingImages(
  listing: StorefrontListing,
  signer: (paths: readonly string[]) => Promise<(string | null)[]> = signSkuImagePaths,
): Promise<StorefrontListing> {
  const paths = (listing.image_paths ?? []).filter(Boolean);
  if (paths.length === 0) return listing;
  const signed = (await signer(paths)).filter((url): url is string => Boolean(url));
  if (signed.length === 0) return listing;
  return { ...listing, cover_url: signed[0], image_urls: signed };
}

/**
 * 跨 listing 一次性签名：把所有 listing 的 image_paths 拍平后只调一次 signer
 * （signer 内部按桶分组 → 每桶一次 createSignedUrls），再按偏移切回各自 listing。
 */
export async function resolveStorefrontListingsImagesBatch(
  listings: StorefrontListing[],
  signer: ImageSigner = signSkuImagePaths,
): Promise<StorefrontListing[]> {
  const flat: string[] = [];
  const spans = listings.map((listing) => {
    const paths = (listing.image_paths ?? []).filter(Boolean);
    const start = flat.length;
    flat.push(...paths);
    return { start, end: flat.length };
  });
  if (flat.length === 0) return listings;
  const signedAll = await signer(flat);
  return listings.map((listing, i) => {
    const signed = signedAll
      .slice(spans[i].start, spans[i].end)
      .filter((url): url is string => Boolean(url));
    if (signed.length === 0) return listing;
    return { ...listing, cover_url: signed[0], image_urls: signed };
  });
}

export type StorefrontProduct = ReturnType<typeof buildStorefrontProduct>;

/**
 * 只对“当前页”的商品签名：原图桶级批量 + 可选 480px 缩略图。
 * - image_url / image_urls 契约不变（原图签名）
 * - thumbnail_url 只返回真实衍生图；失败为 null，绝不回退原图
 */
export async function signStorefrontProductImages(
  products: StorefrontProduct[],
  listingsById: Map<string, StorefrontListing>,
  options: { thumbnail?: boolean; signer?: ImageSigner; thumbnailSigner?: ImageSigner; originals?: boolean; tencentManifest?: Awaited<ReturnType<typeof loadTencentMediaManifest>> } = {},
): Promise<StorefrontProduct[]> {
  const signer = options.signer ?? signSkuImagePaths;
  const thumbnailSigner = options.thumbnailSigner ?? signDerivativeUrls;
  const pageListings = products.map(
    (product) =>
      listingsById.get(product.id) ?? {
        id: product.id,
        sku_id: product.sku_id,
        location_id: null,
        title: product.name,
        description: null,
        cover_url: product.image_url,
        image_urls: product.image_urls,
        image_paths: [],
        price: product.price,
        compare_at_price: null,
        condition_grade: null,
        product_type: product.product_type,
        published_at: null,
        location: null,
      },
  ).map(resolveListingImageSources);
  const coverPaths = pageListings.map((listing) => (listing.image_paths ?? []).find(Boolean) ?? listing.cover_url ?? listing.image_urls?.[0] ?? "");
  const thumbnails = async (): Promise<(string | null)[]> => {
    if (!options.thumbnail) return [];
    try {
      const ready = coverPaths.map(path => tencentDerivative(path, 640, options.tencentManifest ?? null));
      const missing = coverPaths.map((path, index) => ({ path, index })).filter(row => !ready[row.index]);
      if (missing.length) {
        const fallback = await thumbnailSigner(missing.map(row => row.path));
        missing.forEach((row, index) => { ready[row.index] = fallback[index] ?? null; });
      }
      return ready;
    } catch {
      return [];
    }
  };
  const [resolved, thumbs] = await Promise.all([
    options.originals === false ? Promise.resolve(pageListings) : resolveStorefrontListingsImagesBatch(pageListings, signer),
    thumbnails(),
  ]);
  return products.map((product, i) => {
    const listing = resolved[i];
    const image_url = options.originals === false ? null : listing.cover_url ?? product.image_url;
    const image_urls = options.originals === false ? [] : listing.image_urls ?? product.image_urls;
    const base = { ...product, image_url, image_urls };
    if (!options.thumbnail) return base;
    return { ...base, thumbnail_url: thumbs[i] ?? null,
      ...(options.originals === false ? { preview_url: tencentDerivative(coverPaths[i], 1280, options.tencentManifest ?? null) } : {}) };
  });
}

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

type StorefrontJoinedSku = StorefrontSku & {
  status: string;
  is_display: boolean;
  brand_id: string | null;
  brand: StorefrontBrand | null;
  facet_links: Array<{ confidence: number | null; facet: Omit<StorefrontFacet, "confidence"> | null }>;
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
    min_price: url.searchParams.has("min_price") && url.searchParams.get("min_price")?.trim() !== "" && Number.isFinite(Number(url.searchParams.get("min_price"))) && Number(url.searchParams.get("min_price")) >= 0
      ? Number(url.searchParams.get("min_price")) : null,
    max_price: url.searchParams.has("max_price") && url.searchParams.get("max_price")?.trim() !== "" && Number.isFinite(Number(url.searchParams.get("max_price"))) && Number(url.searchParams.get("max_price")) >= 0
      ? Number(url.searchParams.get("max_price")) : null,
    condition_grades: collectList(url.searchParams, "condition_grades"),
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

export function storefrontBatches<T>(items: T[]): T[][] {
  const batches: T[][] = [];
  for (let i=0; i<items.length; i+=100) batches.push(items.slice(i,i+100));
  return batches;
}

type StorefrontCategoryRow = { id: string; code: string; name: string; parent_id: string | null };

export function loadStorefrontCategories(): Promise<StorefrontCategoryRow[]> {
  return collectStorefrontPages(async (offset, limit) => {
    const { data, error } = await supabaseAdmin.from("inv_categories" as never)
      .select("id, code, name, parent_id").order("id", { ascending: true }).range(offset, offset + limit - 1);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as StorefrontCategoryRow[];
  });
}

export async function enrichStorefrontListings(listings: StorefrontListing[], options: { signImages?: boolean; categoryMetadata?: Promise<StorefrontCategoryRow[]>; useListingMetadata?: boolean } = {}): Promise<ReturnType<typeof buildStorefrontProduct>[]> {
  if (options.useListingMetadata) listings = listings.filter(listing =>
    listing.sku?.id === listing.sku_id && listing.sku.status === "active" && listing.sku.is_display === true,
  );
  if (listings.length>100) {
    const categoryMetadata = options.categoryMetadata ?? loadStorefrontCategories();
    return (await Promise.all(storefrontBatches(listings).map(batch=>enrichStorefrontListings(batch, { ...options, categoryMetadata })))).flat();
  }
  if (options.signImages !== false) listings = await resolveStorefrontListingsImagesBatch(listings);
  const skuIds = [...new Set(listings.map((listing) => listing.sku_id).filter(Boolean))];
  if (skuIds.length === 0) return [];
  const joinedSkus = options.useListingMetadata
    ? [...new Map(listings.map(listing => [listing.sku_id, listing.sku as StorefrontJoinedSku])).values()]
    : null;

  const [skuResult, facetResult, availabilityResult, categoryRows] = await Promise.all([
    joinedSkus ? Promise.resolve({ data: joinedSkus, error: null }) : supabaseAdmin
      .from("inv_skus")
      .select("id, category, brand_id, keywords, stock_qty, brand:inv_brands!inv_skus_brand_id_fkey(id,name,name_original,logo_url)")
      .eq("status", "active")
      .eq("is_display", true)
      .in("id", skuIds),
    joinedSkus ? Promise.resolve({ data: joinedSkus.flatMap(sku => (sku.facet_links ?? []).map(link => ({ ...link, sku_id: sku.id }))), error: null }) : supabaseAdmin
      .from("inv_sku_facets" as never)
      .select("sku_id, confidence, facet:inv_facets(code, name, dimension)")
      .in("sku_id", skuIds),
    supabaseAdmin.rpc(
      "commerce_listing_availability" as never,
      {
        p_listing_ids: listings.map((listing) => listing.id),
      } as never,
    ),
    options.categoryMetadata ?? loadStorefrontCategories(),
  ]);
  if (skuResult.error) throw new Error(skuResult.error.message);
  if (facetResult.error) throw new Error(facetResult.error.message);
  if (availabilityResult.error) throw new Error(availabilityResult.error.message);

  const skus = (skuResult.data ?? []) as unknown as Array<
    StorefrontSku & { brand_id: string | null; brand: StorefrontBrand | null }
  >;
  const parentNames = new Map(
    categoryRows.map((row) => [
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
        brand: sku.brand ?? null,
        facets: facets.get(sku.id) ?? [],
        availableQty: availability.get(listing.id) ?? 0,
      }),
    ];
  });
}
