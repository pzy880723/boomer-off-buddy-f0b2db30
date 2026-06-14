import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listStocktakes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("stocktakes")
      .select(
        "id, code, status, opened_at, submitted_at, reviewed_at, location_id, location:inv_locations!location_id(id, name, kind)"
      )
      .order("opened_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const getStocktake = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { data: head, error } = await context.supabase
      .from("stocktakes")
      .select(
        "id, code, status, opened_at, submitted_at, reviewed_at, review_note, notes, location_id, location:inv_locations!location_id(id, name, kind)"
      )
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!head) throw new Error("Not found");

    const { data: lines } = await context.supabase
      .from("stocktake_lines")
      .select("id, sku_id, system_qty, counted_qty, diff, reason, sku:inv_skus(id, sku_code, name)")
      .eq("stocktake_id", data.id)
      .order("diff");
    const { data: scans } = await context.supabase
      .from("stocktake_scans")
      .select("epc, sku_id")
      .eq("stocktake_id", data.id)
      .is("sku_id", null)
      .limit(200);
    return { head, lines: lines ?? [], unknown_scans: scans ?? [] };
  });

export const approveStocktake = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({ id: z.string().uuid(), note: z.string().optional() }).parse(i)
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: st } = await supabaseAdmin
      .from("stocktakes")
      .select("id, status, location_id")
      .eq("id", data.id)
      .maybeSingle();
    if (!st) throw new Error("Not found");
    if (st.status !== "submitted") throw new Error(`status=${st.status}`);

    const { data: lines } = await supabaseAdmin
      .from("stocktake_lines")
      .select("sku_id, diff")
      .eq("stocktake_id", data.id);

    for (const line of lines ?? []) {
      const row = line as any;
      if (!row.diff) continue;
      const { error } = await supabaseAdmin.rpc("inv_apply_movement", {
        p_sku_id: row.sku_id,
        p_location_id: st.location_id,
        p_delta: row.diff,
        p_ref_type: "stocktake",
        p_ref_id: data.id,
        p_note: "stocktake approval",
      } as never);
      if (error) throw new Error(`mv ${row.sku_id}: ${error.message}`);
    }

    await supabaseAdmin
      .from("stocktakes")
      .update({
        status: "approved",
        reviewed_at: new Date().toISOString(),
        reviewed_by: context.userId,
        review_note: data.note ?? null,
      })
      .eq("id", data.id);
    return { ok: true };
  });

export const rejectStocktake = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({ id: z.string().uuid(), note: z.string().optional() }).parse(i)
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("stocktakes")
      .update({
        status: "rejected",
        reviewed_at: new Date().toISOString(),
        reviewed_by: context.userId,
        review_note: data.note ?? null,
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
