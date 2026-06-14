import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listUnclaimed = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("inv_unclaimed_epcs")
      .select(
        "epc, hits, last_seen_at, note, last_seen_location_id, location:inv_locations!last_seen_location_id(id, name, kind)"
      )
      .order("last_seen_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const claimEpc = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        epc: z.string().min(1),
        sku_id: z.string().uuid(),
        location_id: z.string().uuid(),
        apply_inbound: z.boolean().default(true),
      })
      .parse(i)
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Insert/update inv_epcs as in_stock at location
    const { error: upErr } = await supabaseAdmin
      .from("inv_epcs")
      .upsert(
        {
          epc: data.epc,
          sku_id: data.sku_id,
          current_location_id: data.location_id,
          status: "in_stock",
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "epc" }
      );
    if (upErr) throw new Error(upErr.message);

    if (data.apply_inbound) {
      const { error: mvErr } = await supabaseAdmin.rpc("inv_apply_movement", {
        p_sku_id: data.sku_id,
        p_location_id: data.location_id,
        p_delta: 1,
        p_ref_type: "claim_epc",
        p_epc: data.epc,
        p_note: "manual claim",
      } as never);
      if (mvErr) throw new Error(mvErr.message);
    }
    await supabaseAdmin.from("inv_unclaimed_epcs").delete().eq("epc", data.epc);
    return { ok: true };
  });

export const discardUnclaimed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ epc: z.string().min(1) }).parse(i))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("inv_unclaimed_epcs")
      .delete()
      .eq("epc", data.epc);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
