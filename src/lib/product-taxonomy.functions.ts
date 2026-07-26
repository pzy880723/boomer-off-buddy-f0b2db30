import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { FACET_DIMENSIONS, normalizeLookupText } from "./product-taxonomy";

export type BrandRow = {
  id: string;
  name: string;
  name_original: string | null;
  normalized_name: string;
  aliases: string[];
  entity_type: "brand" | "manufacturer" | "kiln" | "studio" | "designer";
  origin_country: string | null;
  origin_region: string | null;
  category_codes: string[];
  logo_url: string | null;
  status: "active" | "inactive" | "review";
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type FacetRow = {
  id: string;
  code: string;
  name: string;
  dimension: (typeof FACET_DIMENSIONS)[number];
  parent_id: string | null;
  aliases: string[];
  category_codes: string[];
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
};

const stringList = z.array(z.string().trim().min(1).max(80)).max(50).default([]);

export const listBrands = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        search: z.string().trim().max(100).optional(),
        status: z.enum(["active", "inactive", "review"]).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("inv_brands" as never)
      .select("*")
      .order("status", { ascending: true })
      .order("name", { ascending: true });
    if (data.status) query = query.eq("status", data.status);
    if (data.search) {
      const term = data.search.replace(/[,%()]/g, " ").trim();
      if (term) {
        query = query.or(
          `name.ilike.%${term}%,name_original.ilike.%${term}%,normalized_name.ilike.%${normalizeLookupText(term)}%`,
        );
      }
    }
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return { rows: (rows ?? []) as unknown as BrandRow[] };
  });

const BrandInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100),
  name_original: z.string().trim().max(100).nullable().optional(),
  aliases: stringList,
  entity_type: z.enum(["brand", "manufacturer", "kiln", "studio", "designer"]).default("brand"),
  origin_country: z.string().trim().max(60).nullable().optional(),
  origin_region: z.string().trim().max(60).nullable().optional(),
  category_codes: stringList,
  logo_url: z.string().url().max(500).nullable().optional().or(z.literal("")),
  status: z.enum(["active", "inactive", "review"]).default("active"),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export type BrandInputValue = z.infer<typeof BrandInput>;

export const upsertBrand = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => BrandInput.parse(input))
  .handler(async ({ data, context }) => {
    const now = new Date().toISOString();
    const payload = {
      name: data.name,
      name_original: data.name_original || null,
      normalized_name: normalizeLookupText(data.name),
      aliases: [...new Set(data.aliases)],
      entity_type: data.entity_type,
      origin_country: data.origin_country || null,
      origin_region: data.origin_region || null,
      category_codes: [...new Set(data.category_codes)],
      logo_url: data.logo_url || null,
      status: data.status,
      notes: data.notes || null,
      updated_at: now,
    };
    const query = context.supabase.from("inv_brands" as never);
    if (data.id) {
      const { error } = await query.update(payload as never).eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: row, error } = await query
      .insert(payload as never)
      .select("id")
      .single();
    if (error || !row) throw new Error(error?.message ?? "品牌创建失败");
    return { id: String((row as unknown as { id: string }).id) };
  });

export const deleteBrand = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { count, error: countError } = await context.supabase
      .from("inv_skus" as never)
      .select("id", { count: "exact", head: true })
      .eq("brand_id", data.id);
    if (countError) throw new Error(countError.message);
    if ((count ?? 0) > 0) throw new Error(`仍有 ${count} 个商品使用该品牌，请改为停用`);
    const { error } = await context.supabase
      .from("inv_brands" as never)
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listFacets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        dimension: z.enum(FACET_DIMENSIONS).optional(),
        include_inactive: z.boolean().default(true),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("inv_facets" as never)
      .select(
        "id, code, name, dimension, parent_id, aliases, category_codes, sort_order, is_active, is_system",
      )
      .order("dimension", { ascending: true })
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });
    if (data.dimension) query = query.eq("dimension", data.dimension);
    if (!data.include_inactive) query = query.eq("is_active", true);
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return { rows: (rows ?? []) as unknown as FacetRow[] };
  });

const FacetInput = z.object({
  id: z.string().uuid().optional(),
  code: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/u, "编码仅支持小写字母、数字和下划线"),
  name: z.string().trim().min(1).max(80),
  dimension: z.enum(FACET_DIMENSIONS),
  aliases: stringList,
  category_codes: stringList,
  sort_order: z.number().int().min(0).max(9999).default(0),
  is_active: z.boolean().default(true),
});

export const upsertFacet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => FacetInput.parse(input))
  .handler(async ({ data, context }) => {
    const payload = {
      code: data.code,
      name: data.name,
      dimension: data.dimension,
      aliases: [...new Set(data.aliases)],
      category_codes: [...new Set(data.category_codes)],
      sort_order: data.sort_order,
      is_active: data.is_active,
      updated_at: new Date().toISOString(),
    };
    const table = context.supabase.from("inv_facets" as never);
    if (data.id) {
      const { error } = await table.update(payload as never).eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: row, error } = await table
      .insert(payload as never)
      .select("id")
      .single();
    if (error || !row) throw new Error(error?.message ?? "标签创建失败");
    return { id: String((row as unknown as { id: string }).id) };
  });

export const setFacetActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid(), is_active: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("inv_facets" as never)
      .update({ is_active: data.is_active, updated_at: new Date().toISOString() } as never)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const searchInventoryByTaxonomy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        q: z.string().trim().max(120).nullable().optional(),
        primary_category: z.string().trim().max(64).nullable().optional(),
        brand_ids: z.array(z.string().uuid()).max(50).default([]),
        facet_codes: z.array(z.string().trim().min(1).max(64)).max(100).default([]),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: matches, error } = await context.supabase.rpc(
      "search_inv_skus" as never,
      {
        p_query: data.q || null,
        p_primary_category: data.primary_category || null,
        p_brand_ids: data.brand_ids,
        p_facet_codes: data.facet_codes,
        p_limit: data.limit,
        p_offset: data.offset,
      } as never,
    );
    if (error) throw new Error(error.message);
    const ranked = (matches ?? []) as unknown as Array<{ sku_id: string; search_rank: number }>;
    const ids = ranked.map((row) => row.sku_id);
    if (ids.length === 0) return { rows: [] };

    const [skus, facets] = await Promise.all([
      context.supabase
        .from("inv_skus" as never)
        .select(
          "id, sku_code, name, category, status, barcode, brand:inv_brands(id, name, name_original, logo_url)",
        )
        .in("id", ids),
      context.supabase
        .from("inv_sku_facets" as never)
        .select("sku_id, confidence, source, facet:inv_facets(id, code, name, dimension)")
        .in("sku_id", ids),
    ]);
    if (skus.error) throw new Error(skus.error.message);
    if (facets.error) throw new Error(facets.error.message);
    type SearchFacet = {
      sku_id: string;
      confidence: number | null;
      source: string;
      facet: {
        id: string;
        code: string;
        name: string;
        dimension: string;
      } | null;
    };
    type SearchSku = {
      id: string;
      sku_code: string;
      name: string;
      category: string | null;
      status: string;
      barcode: string | null;
      brand: {
        id: string;
        name: string;
        name_original: string | null;
        logo_url: string | null;
      } | null;
    };
    const facetRows = (facets.data ?? []) as unknown as SearchFacet[];
    const facetMap = new Map<string, SearchFacet[]>();
    for (const row of facetRows) {
      const skuId = String(row.sku_id);
      facetMap.set(skuId, [...(facetMap.get(skuId) ?? []), row]);
    }
    const skuMap = new Map(
      ((skus.data ?? []) as unknown as SearchSku[]).map((row) => [row.id, row]),
    );
    return {
      rows: ranked.flatMap((match) => {
        const sku = skuMap.get(match.sku_id);
        return sku
          ? [{ ...sku, search_rank: match.search_rank, facets: facetMap.get(match.sku_id) ?? [] }]
          : [];
      }),
    };
  });
