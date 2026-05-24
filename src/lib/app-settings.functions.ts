import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const KEY = "inv_price_tiers";
const DEFAULTS = [6.9, 9.9, 15.9, 19.9, 29.9, 39.9, 49.9];

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
