import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  ENGAGEMENT_WINDOW_DAYS,
  matchVocabulary,
  type EngagementInput,
  type VocabularyTerm,
} from "@/lib/commerce/storefront-engagement";
import { buildDiscoveryTerms, countAvailableTags } from "@/lib/commerce/storefront-discovery";

import type { ConsumerChannel } from "@/lib/sales-channels/model";

export type EngagementCounts = { view_count: number; favorite_count: number };
type Db = typeof supabaseAdmin;

export async function loadSearchVocabulary(db: Db = supabaseAdmin): Promise<VocabularyTerm[]> {
  const [brands, facets, categories] = await Promise.all([
    db.from("inv_brands" as never).select("id, name, aliases").eq("status", "active"),
    db.from("inv_facets" as never).select("code, name, aliases").eq("is_active", true),
    db.from("inv_categories" as never).select("code, name").eq("kind", "category").eq("is_active", true),
  ]);
  const err = brands.error ?? facets.error ?? categories.error;
  if (err) throw new Error(err.message);
  const out: VocabularyTerm[] = [];
  for (const b of (brands.data ?? []) as Array<{ id: string; name: string; aliases: string[] | null }>)
    out.push({ key: `brand:${b.id}`, label: b.name, query: b.name, aliases: b.aliases ?? [] });
  for (const f of (facets.data ?? []) as Array<{ code: string; name: string; aliases: string[] | null }>)
    out.push({ key: `facet:${f.code}`, label: f.name, query: f.name, aliases: f.aliases ?? [] });
  for (const c of (categories.data ?? []) as Array<{ code: string; name: string }>)
    out.push({ key: `category:${c.code}`, label: c.name, query: c.name, aliases: [] });
  return out.filter((t) => /^(brand|facet|category):[A-Za-z0-9_-]{1,80}$/.test(t.key) && t.label.length <= 40);
}

/** 按“顾客+日期+词”单向散列，不可跨词/跨日拼出个人搜索历史。 */
export async function visitorKey(customerId: string, termKey: string, day: string): Promise<string> {
  const salt = process.env["STOREFRONT_ENGAGEMENT_SALT"] ?? "boomer-storefront-engagement";
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${customerId}|${day}|${termKey}`));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function shanghaiDay(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

export async function recordEngagement(customerId: string, input: EngagementInput, db: Db = supabaseAdmin) {
  let action: string = input.kind;
  let termKey: string | null = null;
  let label: string | null = null;
  let vKey: string | null = null;
  if (input.kind === "favorite") action = input.selected ? "favorite" : "unfavorite";
  if (input.kind === "search") {
    const term = matchVocabulary(input.query ?? "", await loadSearchVocabulary(db));
    if (!term) return { recorded: false, reason: "not_in_vocabulary" };
    termKey = term.key;
    label = term.label;
    vKey = await visitorKey(customerId, term.key, shanghaiDay());
  }
  const { data, error } = await db.rpc("storefront_record_engagement" as never, {
    p_customer_id: customerId,
    p_action: action,
    p_listing_id: input.kind === "search" ? null : input.product_id,
    p_term_key: termKey,
    p_label: label,
    p_visitor_key: vKey,
  } as never);
  if (error) throw new Error(error.message);
  return data as { recorded: boolean; active?: boolean; reason?: string | null };
}

export async function loadEngagementCounts(listingIds: readonly string[], db: Db = supabaseAdmin) {
  const map = new Map<string, EngagementCounts>();
  if (!listingIds.length) return map;
  const { data, error } = await db.rpc("storefront_product_engagement_counts" as never, {
    p_listing_ids: [...new Set(listingIds)],
  } as never);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as Array<{ listing_id: string } & EngagementCounts>)
    map.set(row.listing_id, { view_count: row.view_count ?? 0, favorite_count: row.favorite_count ?? 0 });
  return map;
}

export function withCounts<T extends { id: string }>(items: readonly T[], counts: Map<string, EngagementCounts>) {
  return items.map((item) => ({ ...item, ...(counts.get(item.id) ?? { view_count: 0, favorite_count: 0 }) }));
}

const LISTING_PAGE = 1000;

/** All currently purchasable products, using the same published + enrich + stock>0 path as the list. */
export async function loadAvailableProductsForDiscovery(db: Db = supabaseAdmin, channel: ConsumerChannel = "unknown") {
  const { enrichStorefrontListings } = await import("./storefront-products.server");
  const { filterListingsForConsumerChannel } = await import("./sales-channels.server");
  const listings: unknown[] = [];
  for (let from = 0; ; from += LISTING_PAGE) {
    // Paged reads so counting never truncates at the default 1000-row cap.
    const { data, error } = await db.from("storefront_ready_listings" as never)
      .select("id, sku_id, location_id, title, description, cover_url, image_urls, image_paths, price, compare_at_price, condition_grade, product_type, published_at, location:inv_locations!location_id(id,name,kind)")
      .eq("status", "published").order("id").range(from, from + LISTING_PAGE - 1);
    if (error) throw new Error(error.message);
    listings.push(...(data ?? []));
    if (!data || data.length < LISTING_PAGE) break;
  }
  if (!listings.length) return [];
  // 与商品列表同一渠道展示过滤：当前来源被显式关闭的商品不计入发现/标签计数（未知来源取两渠道交集）。
  const visible = await filterListingsForConsumerChannel(listings as Array<{ sku_id: string; location_id: string | null }>, channel);
  if (!visible.length) return [];
  const enriched = await enrichStorefrontListings(visible as never, { signImages: false });
  return enriched.filter((product) => product.stock > 0);
}

export async function loadDiscovery(db: Db = supabaseAdmin, channel: ConsumerChannel = "unknown") {
  const [hotRes, products, catRes] = await Promise.all([
    db.rpc("storefront_hot_search_terms" as never, { p_window_days: ENGAGEMENT_WINDOW_DAYS, p_limit: 20 } as never),
    loadAvailableProductsForDiscovery(db, channel),
    db.from("inv_categories" as never).select("code, parent:inv_categories!parent_id(code)"),
  ]);
  if (hotRes.error) throw new Error(hotRes.error.message);
  if (catRes.error) throw new Error(catRes.error.message);
  const parents = new Map(((catRes.data ?? []) as Array<{ code: string; parent: { code: string } | null }>)
    .map((c) => [c.code, c.parent?.code ?? null]));
  const counts = countAvailableTags(products as never, parents);
  const terms = buildDiscoveryTerms((hotRes.data ?? []) as Array<{ term_key: string; label: string; searchers: number }>, counts);
  const fromSearch = terms.some((t) => t.search_count !== null);
  const fromInventory = terms.some((t) => t.search_count === null);
  return {
    source: !terms.length ? ("preset" as const) : fromSearch && fromInventory ? ("mixed" as const) : fromSearch ? ("actual" as const) : ("inventory" as const),
    terms,
    window_days: ENGAGEMENT_WINDOW_DAYS,
    available_product_total: products.length,
  };
}
