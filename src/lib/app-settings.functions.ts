import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { PRICE_TIERS } from "@/lib/inventory.helpers";

const KEY = "inv_price_tiers";
const DEFAULTS = [...PRICE_TIERS];

function normalize(tiers: number[]): number[] {
  const set = new Set<number>();
  for (const t of tiers) {
    if (!Number.isFinite(t) || t <= 0 || t > 9999.9) continue;
    const r = Math.round(t * 10) / 10;
    set.add(r);
  }
  return Array.from(set).sort((a, b) => a - b);
}

export const getPriceTiers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", KEY)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const raw = (data?.value as unknown) as number[] | null;
    const tiers = Array.isArray(raw) ? normalize(raw) : DEFAULTS;
    return { tiers };
  });

export const setPriceTiers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ tiers: z.array(z.number()).max(50) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const tiers = normalize(data.tiers);
    const { error } = await supabase
      .from("app_settings")
      .upsert({ key: KEY, value: tiers, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    return { tiers };
  });

/* ---------- 有赞同步默认商品分组 ---------- */
const HQ_CAT_KEY = "youzan_hq_default_category_id";

export const getYouzanDefaultCategoryId = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("app_settings")
      .select("value")
      .eq("key", HQ_CAT_KEY)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const raw = (data?.value as unknown) ?? null;
    const id = Number(
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? raw
          : (raw as { id?: number } | null)?.id ?? 0,
    );
    const meta = raw && typeof raw === "object" ? (raw as { name?: string; auto?: boolean }) : null;
    return { id: id > 0 ? id : null, name: meta?.name ?? null, auto: Boolean(meta?.auto) };
  });

export const setYouzanDefaultCategoryId = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ id: z.number().int().positive().nullable() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("app_settings").upsert({
      key: HQ_CAT_KEY,
      value: data.id,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
    return { id: data.id };
  });

export const ensureYouzanDefaultCategoryId = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { ensureAutoYouzanDefaultCategory } = await import("@/lib/youzan-sync.functions");
    const result = await ensureAutoYouzanDefaultCategory();
    return { id: result.id, name: "ERP自动同步", created: result.created, auto: true };
  });
