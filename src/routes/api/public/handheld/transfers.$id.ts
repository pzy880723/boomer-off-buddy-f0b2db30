import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/handheld/transfers/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const { data, error } = await supabaseAdmin
          .from("stock_transfers")
          .select(
            "id, code, status, qty, from_location_id, to_location_id, shipped_at, received_at, created_at, notes, lines:stock_transfer_lines(sku_id, expected_qty, shipped_qty, received_qty), epcs:stock_transfer_epcs(epc, sku_id, ship_scanned_at, receive_scanned_at)",
          )
          .eq("id", params.id)
          .maybeSingle();
        if (error) return err(error.message, 500);
        if (!data) return err("Not found", 404, { code: "not_found" });
        return ok(data);
      },
    },
  },
});
