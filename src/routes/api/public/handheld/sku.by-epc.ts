import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/handheld/sku/by-epc")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const url = new URL(request.url);
        const epc = (url.searchParams.get("epc") || "").trim();
        if (!epc) return err("Missing epc", 400);

        const { data: epcRow } = await supabaseAdmin
          .from("inv_epcs")
          .select(
            "epc, status, sku_id, current_location_id, sku:inv_skus(id, sku_code, name, category, price_tier, stock_qty), location:inv_locations!current_location_id(id, name, kind)",
          )
          .eq("epc", epc)
          .maybeSingle();

        if (!epcRow) {
          const { data: unc } = await supabaseAdmin
            .from("inv_unclaimed_epcs")
            .select("epc, hits, last_seen_at")
            .eq("epc", epc)
            .maybeSingle();
          return ok({ known: false, unclaimed: unc ?? null });
        }
        return ok({ known: true, ...epcRow });
      },
    },
  },
});
