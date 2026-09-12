import { supabaseAdmin } from "../integrations/supabase/client.server";
import { signSkuImagePaths, signSkuThumbnailPaths } from "../lib/sku-image-resolver.server";

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
  image_paths: string[] | null;
  price: number;
  compare_at_price: number | null;
  condition_grade: string | null;
  product_type: "custom" | "standard" | "bundle";
  published_at: string | null;
  location: { id: string; name: string; kind: string } | null;
};

export type ImageSigner = (paths: readonly string[]) => Promise<(string | null)[]>;

export async function resolveStorefrontListingImages(
  listing: StorefrontListing,
  signer: ImageSigner = signSkuImagePaths,
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
 * - thumbnail_url 为新增可选字段；缩略图签名失败回退原图 URL
 */
export async function signStorefrontProductImages(
  products: StorefrontProduct[],
  listingsById: Map<string, StorefrontListing>,
  options: { thumbnail?: boolean; signer?: ImageSigner; thumbnailSigner?: ImageSigner } = {},
): Promise<StorefrontProduct[]> {
  const signer = options.signer ?? signSkuImagePaths;
  const thumbnailSigner = options.thumbnailSigner ?? signSkuThumbnailPaths;
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
  );
  const resolved = await resolveStorefrontListingsImagesBatch(pageListings, signer);
  const coverPaths = resolved.map((listing) => (listing.image_paths ?? []).find(Boolean) ?? "");
  let thumbs: (string | null)[] = [];
  if (options.thumbnail) {
    try {
      thumbs = await thumbnailSigner(coverPaths);
    } catch {
      thumbs = [];
    }
  }
  return products.map((product, i) => {
    const listing = resolved[i];
    const image_url = listing.cover_url ?? product.image_url;
    const image_urls = listing.image_urls ?? product.image_urls;
    const base = { ...product, image_url, image_urls };
    if (!options.thumbnail) return base;
    return { ...base, thumbnail_url: thumbs[i] ?? image_url };
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

/**
 * 详情页单商品装配：先 signImages:false 富化并确认可售（stock >= 1），
 * 再仅对这一个商品调用 signStorefrontProductImages(..., { thumbnail: true })，
 * 避免“先签原图再签一遍缩略图”的重复签名。
 * 不可售（无 SKU / stock < 1）返回 null，由路由映射为 404。
 * 缩略图签名失败时 thumbnail_url 回退原图（signStorefrontProductImages 内建行为）。
 */
export async function buildStorefrontProductDetail(
  listing: StorefrontListing,
  options: {
    signer?: ImageSigner;
    thumbnailSigner?: ImageSigner;
    /** 测试注入用：默认 enrichStorefrontListings(signImages:false) */
    enrich?: (
      listings: StorefrontListing[],
      options: { signImages?: boolean },
    ) => Promise<StorefrontProduct[]>;
  } = {},
): Promise<(StorefrontProduct & { thumbnail_url?: string | null }) | null> {
  const enrich = options.enrich ?? enrichStorefrontListings;
  const products = await enrich([listing], { signImages: false });
  const product = products[0];
  if (!product || product.stock < 1) return null;
  const listingsById = new Map([[listing.id, listing]]);
  const [signed] = await signStorefrontProductImages([product], listingsById, {
    thumbnail: true,
    signer: options.signer,
    thumbnailSigner: options.thumbnailSigner,
  });
  return signed;
}

/**
 * 元数据富化（分类/品牌/facets/可售库存）。
 * signImages=true（默认，详情页沿用）：桶级批量签名原图；
 * signImages=false：不做任何签名，留给调用方在筛选/分页之后对当前页调用 signStorefrontProductImages。
 */
export async function enrichStorefrontListings(
  listings: StorefrontListing[],
  options: { signImages?: boolean } = {},
) {
  if (options.signImages !== false) {
    listings = await resolveStorefrontListingsImagesBatch(listings);
  }
  const skuIds = [...new Set(listings.map((listing) => listing.sku_id).filter(Boolean))];
  if (skuIds.length === 0) return [];

  const [skuResult, facetResult, availabilityResult] = await Promise.all([
    // 与腾讯分支 525acd6 对齐：隐藏 / 非 active SKU 不进入公开商品（在 total/分页计算之前排除）
    supabaseAdmin
      .from("inv_skus")
      .select("id, category, brand_id, keywords, stock_qty")
      .eq("status", "active")
      .eq("is_display", true)
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
