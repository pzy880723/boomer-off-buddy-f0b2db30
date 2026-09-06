import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok } from "@/server/handheld-auth.server";
import { errCode } from "@/lib/handheld/errors";
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
          return errCode("invalid_body", undefined, { detail: String(e) });
        }

        const { data: e } = await supabaseAdmin
          .from("inv_epcs")
          .select("epc, sku_id, current_location_id")
          .eq("epc", body.epc)
          .maybeSingle();
        if (!e || !e.sku_id) return errCode("not_found", "EPC not bound");

        const from = e.current_location_id;
        const to = body.to_location_id;
        if (from === to) return ok({ epc: body.epc, from_location_id: from, to_location_id: to });

        // Devices may only relocate items at their own location, unless device is a warehouse
        if (auth.device.location_kind !== "warehouse" && from && from !== auth.device.location_id) {
          return errCode(
            "transfer_required",
            "EPC currently belongs to another location; create a stock transfer instead",
            { from_location_id: from, to_location_id: to },
          );
        }
        if (auth.device.location_kind !== "warehouse" && to !== auth.device.location_id) {
          return errCode(
            "unauthorized_location",
            "Cannot relocate to a location other than current device",
            {
              device_location_id: auth.device.location_id,
              to_location_id: to,
            },
          );
        }

        if (from) {
          const mv1 = await supabaseAdmin.rpc("inv_apply_movement", {
            p_sku_id: e.sku_id,
            p_location_id: from,
            p_delta: -1,
            p_ref_type: "rfid_relocate_out",
            p_epc: body.epc,
            p_note: body.reason ?? null,
          } as never);
          if (mv1.error) return errCode("internal_error", mv1.error.message);
        }
        const mv2 = await supabaseAdmin.rpc("inv_apply_movement", {
          p_sku_id: e.sku_id,
          p_location_id: to,
          p_delta: 1,
          p_ref_type: "rfid_relocate_in",
          p_epc: body.epc,
          p_note: body.reason ?? null,
        } as never);
        if (mv2.error) return errCode("internal_error", mv2.error.message);

        await supabaseAdmin
          .from("inv_epcs")
          .update({ current_location_id: to, last_seen_at: new Date().toISOString() })
          .eq("epc", body.epc);

        // 若 from/to 中任一是门店库位，触发 worker 把变化推给有赞
        try {
          const { data: locs } = await supabaseAdmin
            .from("inv_locations")
            .select("id, kind")
            .in("id", [from, to].filter(Boolean) as string[]);
          const anyShop = (locs ?? []).some((l) => (l as { kind?: string }).kind === "shop");
          if (anyShop) {
            const { triggerStockWorker } = await import("@/lib/youzan-sync.functions");
            triggerStockWorker({ sku_ids: [e.sku_id] });
          }
        } catch {
          /* noop */
        }

        return ok({ epc: body.epc, from_location_id: from, to_location_id: to });
      },
    },
  },
});
