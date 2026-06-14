import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  HANDHELD_CORS,
  authenticateDevice,
  requireWarehouse,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const Body = z.object({ epcs: z.array(z.string().min(1)).min(1).max(500) });

export const Route = createFileRoute("/api/public/handheld/inbound/scan")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const need = requireWarehouse(auth.device);
        if (!need.ok) return need.response;

        let payload: z.infer<typeof Body>;
        try {
          payload = Body.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { detail: String(e) });
        }

        const epcs = Array.from(new Set(payload.epcs.map((s) => s.trim()).filter(Boolean)));
        const locationId = auth.device.location_id!;

        const { data: existing } = await supabaseAdmin
          .from("inv_epcs")
          .select("epc, sku_id, status, current_location_id")
          .in("epc", epcs);

        const existMap = new Map<string, { sku_id: string | null; status: string; current_location_id: string | null }>();
        (existing ?? []).forEach((r: any) => existMap.set(r.epc, r));

        const accepted: { epc: string; sku_id: string }[] = [];
        const duplicated: { epc: string; reason: string }[] = [];
        const unclaimed: string[] = [];

        for (const epc of epcs) {
          const e = existMap.get(epc);
          if (!e) {
            unclaimed.push(epc);
            continue;
          }
          if (!e.sku_id) {
            unclaimed.push(epc);
            continue;
          }
          if (e.status === "in_stock" && e.current_location_id === locationId) {
            duplicated.push({ epc, reason: "already_in_stock" });
            continue;
          }
          if (e.status === "sold") {
            duplicated.push({ epc, reason: "sold" });
            continue;
          }
          // Apply +1 movement to this warehouse location
          const { error: mvErr } = await supabaseAdmin.rpc("inv_apply_movement", {
            p_sku_id: e.sku_id,
            p_location_id: locationId,
            p_delta: 1,
            p_ref_type: "handheld_inbound",
            p_epc: epc,
            p_note: `device:${auth.device.device_code}`,
          } as never);
          if (mvErr) {
            duplicated.push({ epc, reason: `movement_failed:${mvErr.message}` });
            continue;
          }
          await supabaseAdmin
            .from("inv_epcs")
            .update({
              status: "in_stock",
              current_location_id: locationId,
              last_seen_at: new Date().toISOString(),
            })
            .eq("epc", epc);
          accepted.push({ epc, sku_id: e.sku_id });
        }

        // Unclaimed queue (upsert and bump hits)
        for (const epc of unclaimed) {
          await supabaseAdmin
            .from("inv_unclaimed_epcs")
            .upsert(
              {
                epc,
                last_seen_location_id: locationId,
                last_seen_at: new Date().toISOString(),
                hits: 1,
              },
              { onConflict: "epc" }
            );
        }

        return ok({
          accepted_count: accepted.length,
          duplicated_count: duplicated.length,
          unclaimed_count: unclaimed.length,
          accepted,
          duplicated,
          unclaimed,
        });
      },
    },
  },
});
