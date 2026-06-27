import { createFileRoute } from "@tanstack/react-router";
import type { z } from "zod";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { StocktakeScanReq as Body } from "@/lib/handheld/schemas";

export const Route = createFileRoute("/api/public/handheld/stocktake/scan")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { detail: String(e) });
        }

        // Verify stocktake belongs to this device's location and is open
        const { data: st } = await supabaseAdmin
          .from("stocktakes")
          .select("id, location_id, status")
          .eq("id", body.stocktake_id)
          .maybeSingle();
        if (!st) return err("Stocktake not found", 404);
        if (st.location_id !== auth.device.location_id)
          return err("Stocktake location mismatch", 403);
        if (st.status !== "scanning") return err(`Stocktake is ${st.status}, not scanning`, 409);

        const epcs = Array.from(new Set(body.epcs.map((s) => s.trim()).filter(Boolean)));
        const { data: known } = await supabaseAdmin
          .from("inv_epcs")
          .select("epc, sku_id")
          .in("epc", epcs);
        const knownMap = new Map<string, string | null>();
        (known ?? []).forEach((r: any) => knownMap.set(r.epc, r.sku_id));

        const rows = epcs.map((epc) => ({
          stocktake_id: body.stocktake_id,
          epc,
          sku_id: knownMap.get(epc) ?? null,
        }));
        // Upsert by unique (stocktake_id, epc) to dedupe
        const { error } = await supabaseAdmin
          .from("stocktake_scans")
          .upsert(rows, { onConflict: "stocktake_id,epc", ignoreDuplicates: true });
        if (error) return err(error.message, 500);

        const unknown = epcs.filter((e) => !knownMap.has(e));
        return ok({
          received: epcs.length,
          unknown_count: unknown.length,
          unknown,
        });
      },
    },
  },
});
