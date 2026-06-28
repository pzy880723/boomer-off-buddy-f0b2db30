import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { RfidTransferReq } from "@/lib/handheld/schemas";

export const Route = createFileRoute("/api/public/handheld/rfid/transfer-location")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        let body: { epc: string; to_location_id: string; reason?: string };
        try {
          body = RfidTransferReq.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { detail: String(e) });
        }

        const { data: e } = await supabaseAdmin
          .from("inv_epcs")
          .select("epc, sku_id, current_location_id")
          .eq("epc", body.epc)
          .maybeSingle();
        if (!e || !e.sku_id) return err("EPC not bound", 404);

        const from = e.current_location_id;
        const to = body.to_location_id;
        if (from === to) return ok({ epc: body.epc, from_location_id: from, to_location_id: to });

        if (from) {
          const mv1 = await supabaseAdmin.rpc("inv_apply_movement", {
            p_sku_id: e.sku_id,
            p_location_id: from,
            p_delta: -1,
            p_ref_type: "rfid_relocate_out",
            p_epc: body.epc,
            p_note: body.reason ?? null,
          } as never);
          if (mv1.error) return err(mv1.error.message, 500);
        }
        const mv2 = await supabaseAdmin.rpc("inv_apply_movement", {
          p_sku_id: e.sku_id,
          p_location_id: to,
          p_delta: 1,
          p_ref_type: "rfid_relocate_in",
          p_epc: body.epc,
          p_note: body.reason ?? null,
        } as never);
        if (mv2.error) return err(mv2.error.message, 500);

        await supabaseAdmin
          .from("inv_epcs")
          .update({ current_location_id: to, last_seen_at: new Date().toISOString() })
          .eq("epc", body.epc);

        return ok({ epc: body.epc, from_location_id: from, to_location_id: to });
      },
    },
  },
});
