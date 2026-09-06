import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok } from "@/server/handheld-auth.server";
import { errCode } from "@/lib/handheld/errors";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { RfidStockInReq } from "@/lib/handheld/schemas";

export const Route = createFileRoute("/api/public/handheld/rfid/stock-in")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        let body: { epcs: string[] };
        try {
          body = RfidStockInReq.parse(await request.json());
        } catch (e) {
          return errCode("invalid_body", undefined, { detail: String(e) });
        }

        const epcs = Array.from(new Set(body.epcs));
        // Check which are already bound
        const { data: bound } = await supabaseAdmin
          .from("inv_epcs")
          .select("epc, sku_id")
          .in("epc", epcs);
        const alreadyBound = (bound ?? [])
          .filter((b) => b.sku_id)
          .map((b) => ({
            epc: b.epc as string,
            sku_id: b.sku_id as string,
          }));
        const boundSet = new Set(alreadyBound.map((b) => b.epc));
        const fresh = epcs.filter((e) => !boundSet.has(e));

        let queued = 0;
        if (fresh.length > 0) {
          const nowIso = new Date().toISOString();
          for (const epc of fresh) {
            const { error } = await supabaseAdmin.from("inv_unclaimed_epcs").upsert(
              {
                epc,
                last_seen_location_id: auth.device.location_id,
                last_seen_at: nowIso,
                hits: 1,
              },
              { onConflict: "epc" },
            );
            if (!error) queued++;
          }
        }

        return ok({ queued, already_bound: alreadyBound });
      },
    },
  },
});
