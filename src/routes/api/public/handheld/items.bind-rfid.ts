// Alias of /handheld/rfid/bind-item with the APP-preferred path.
import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok } from "@/server/handheld-auth.server";
import { errCode } from "@/lib/handheld/errors";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { RfidBindReq } from "@/lib/handheld/schemas";

export const Route = createFileRoute("/api/public/handheld/items/bind-rfid")({
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
          return errCode("invalid_body", undefined, { detail: String(e) });
        }
        const locationId = body.location_id ?? auth.device.location_id;
        if (!locationId) return errCode("validation_error", "No target location");

        const { data: sku } = await supabaseAdmin
          .from("inv_skus")
          .select("id")
          .eq("id", body.sku_id)
          .maybeSingle();
        if (!sku) return errCode("not_found", "SKU not found");

        const { data: existing } = await supabaseAdmin
          .from("inv_epcs")
          .select("epc, sku_id")
          .eq("epc", body.epc)
          .maybeSingle();
        if (existing?.sku_id && existing.sku_id !== body.sku_id) {
          return errCode("already_exists", "EPC already bound to another SKU", {
            bound_sku_id: existing.sku_id,
          });
        }

        const up = await supabaseAdmin.from("inv_epcs").upsert(
          {
            epc: body.epc,
            sku_id: body.sku_id,
            status: "in_stock",
            current_location_id: locationId,
            last_seen_at: new Date().toISOString(),
          },
          { onConflict: "epc" },
        );
        if (up.error) return errCode("internal_error", up.error.message);

        await supabaseAdmin.from("inv_unclaimed_epcs").delete().eq("epc", body.epc);

        const mv = await supabaseAdmin.rpc("inv_apply_movement", {
          p_sku_id: body.sku_id,
          p_location_id: locationId,
          p_delta: 1,
          p_ref_type: "rfid_bind",
          p_epc: body.epc,
          p_note: `device:${auth.device.device_code}`,
        } as never);
        if (mv.error) return errCode("internal_error", mv.error.message);

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
