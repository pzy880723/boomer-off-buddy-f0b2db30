import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

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
};

const SELECT_COLS =
  "id, name, name_original, normalized_name, aliases, entity_type, origin_country, origin_region, category_codes, logo_url, status, notes";

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export const listBrands = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("inv_brands" as never)
      .select(SELECT_COLS)
      .order("status", { ascending: true })
      .order("name", { ascending: true });
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as unknown as BrandRow[] };
  });

const EntityType = z.enum(["brand", "manufacturer", "kiln", "studio", "designer"]);
const Status = z.enum(["active", "inactive", "review"]);

const UpsertInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  name_original: z.string().trim().max(120).nullable().optional(),
  aliases: z.array(z.string().trim().min(1).max(120)).default([]),
  entity_type: EntityType.default("brand"),
  origin_country: z.string().trim().max(64).nullable().optional(),
  origin_region: z.string().trim().max(64).nullable().optional(),
  category_codes: z.array(z.string().trim().min(1).max(64)).default([]),
  logo_url: z.string().trim().url().max(500).nullable().optional(),
  status: Status.default("active"),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const upsertBrand = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => UpsertInput.parse(i))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const payload: Record<string, unknown> = {
      name: data.name,
      name_original: data.name_original ?? null,
      normalized_name: normalize(data.name),
      aliases: Array.from(new Set(data.aliases.map((a) => a.trim()).filter(Boolean))),
      entity_type: data.entity_type,
      origin_country: data.origin_country ?? null,
      origin_region: data.origin_region ?? null,
      category_codes: data.category_codes,
      logo_url: data.logo_url ?? null,
      status: data.status,
      notes: data.notes ?? null,
    };
    if (data.id) {
      const { error } = await supabase
        .from("inv_brands" as never)
        .update(payload as never)
        .eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: ins, error } = await supabase
      .from("inv_brands" as never)
      .insert(payload as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: (ins as { id: string }).id };
  });

export const setBrandStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({ id: z.string().uuid(), status: Status }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("inv_brands" as never)
      .update({ status: data.status } as never)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteBrand = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { count } = await supabase
      .from("inv_skus")
      .select("id", { count: "exact", head: true })
      .eq("brand_id", data.id);
    if ((count ?? 0) > 0)
      throw new Error(`该品牌下还有 ${count} 个 SKU，不能删除，请先停用`);
    const { error } = await supabase
      .from("inv_brands" as never)
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
