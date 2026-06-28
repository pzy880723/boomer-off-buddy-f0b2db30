import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { RfidBindReq } from "@/lib/handheld/schemas";

export const Route = createFileRoute("/api/public/handheld/rfid/bind-item")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        let body: { epc: string; sku_id: string; location_id?: string };
        try {
          body = RfidBindReq.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { detail: String(e) });
        }
        const locationId = body.location_id ?? auth.device.location_id;
        if (!locationId) return err("No target location", 400);

        const { data: sku } = await supabaseAdmin
          .from("inv_skus")
          .select("id")
          .eq("id", body.sku_id)
          .maybeSingle();
        if (!sku) return err("SKU not found", 404);

        const up = await supabaseAdmin
          .from("inv_epcs")
          .upsert(
            {
              epc: body.epc,
              sku_id: body.sku_id,
              status: "in_stock",
              current_location_id: locationId,
              last_seen_at: new Date().toISOString(),
            },
            { onConflict: "epc" },
          );
        if (up.error) return err(up.error.message, 500);

        await supabaseAdmin.from("inv_unclaimed_epcs").delete().eq("epc", body.epc);

        const mv = await supabaseAdmin.rpc("inv_apply_movement", {
          p_sku_id: body.sku_id,
          p_location_id: locationId,
          p_delta: 1,
          p_ref_type: "rfid_bind",
          p_epc: body.epc,
          p_note: `device:${auth.device.device_code}`,
        } as never);
        if (mv.error) return err(mv.error.message, 500);

        return ok({
          epc: body.epc,
          sku_id: body.sku_id,
          location_id: locationId,
          stock_after: (mv.data as number | null) ?? 0,
        });
      },
    },
  },
});
