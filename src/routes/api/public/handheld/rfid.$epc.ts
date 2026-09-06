import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, json } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/handheld/rfid/$epc")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const epc = params.epc;

        const { data: row } = await supabaseAdmin
          .from("inv_epcs")
          .select(
            "epc, status, sku_id, current_location_id, sku:inv_skus!sku_id(id, sku_code, name, category, price_tier, stock_qty, barcode, grade), location:inv_locations!current_location_id(id, name, kind)",
          )
          .eq("epc", epc)
          .maybeSingle();

        if (row && row.sku_id) {
          return ok({
            known: true as const,
            epc: row.epc,
            status: row.status,
            sku_id: row.sku_id,
            current_location_id: row.current_location_id,
            sku: row.sku ?? null,
            location: row.location ?? null,
          });
        }
        const { data: un } = await supabaseAdmin
          .from("inv_unclaimed_epcs")
          .select("epc, hits, last_seen_at")
          .eq("epc", epc)
          .maybeSingle();
        // APP switches on code='unlinked'
        return json({
          ok: true,
          code: "unlinked",
          data: { known: false as const, unclaimed: un ?? null },
        });
      },
    },
  },
});
