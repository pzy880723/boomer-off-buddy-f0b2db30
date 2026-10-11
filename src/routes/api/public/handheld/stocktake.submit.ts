import { createFileRoute } from "@tanstack/react-router";
import type { z } from "zod";
import { HANDHELD_CORS, authenticateDevice, resolveSessionUser, ok, err } from "@/server/handheld-auth.server";
import { requireStaffAtDeviceLocation } from "@/server/handheld-fulfillment.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { StocktakeSubmitReq as Body } from "@/lib/handheld/schemas";

export const Route = createFileRoute("/api/public/handheld/stocktake/submit")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const staff = await requireStaffAtDeviceLocation(auth.device, await resolveSessionUser(request));
        if (!staff.ok) return staff.response;
        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { detail: String(e) });
        }

        const { data: st } = await supabaseAdmin
          .from("stocktakes")
          .select("id, location_id, status")
          .eq("id", body.stocktake_id)
          .maybeSingle();
        if (!st) return err("Not found", 404);
        if (st.location_id !== staff.locationId) return err("Location mismatch", 403, { code: "location_forbidden" });
        if (st.status !== "scanning") return err(`Already ${st.status}`, 409, { code: "stocktake_closed" });

        // Build lines = group scans by sku_id, compare against inv_stocks at that location.
        const { data: scans } = await supabaseAdmin
          .from("stocktake_scans")
          .select("sku_id")
          .eq("stocktake_id", body.stocktake_id);

        const counted = new Map<string, number>();
        (scans ?? []).forEach((s: any) => {
          if (!s.sku_id) return;
          counted.set(s.sku_id, (counted.get(s.sku_id) ?? 0) + 1);
        });

        const skuIds = Array.from(counted.keys());
        // Also include SKUs with existing stock at this location even if not scanned
        const { data: existingStocks } = await supabaseAdmin
          .from("inv_stocks")
          .select("sku_id, qty")
          .eq("location_id", st.location_id)
          .gt("qty", 0);
        const sysMap = new Map<string, number>();
        (existingStocks ?? []).forEach((s: any) => sysMap.set(s.sku_id, s.qty));
        for (const sid of sysMap.keys()) if (!skuIds.includes(sid)) skuIds.push(sid);

        // Replace lines
        await supabaseAdmin.from("stocktake_lines").delete().eq("stocktake_id", body.stocktake_id);
        const rows = skuIds.map((sku_id) => {
          const system_qty = sysMap.get(sku_id) ?? 0;
          const counted_qty = counted.get(sku_id) ?? 0;
          return {
            stocktake_id: body.stocktake_id,
            sku_id,
            system_qty,
            counted_qty,
            diff: counted_qty - system_qty,
          };
        });
        if (rows.length) {
          const { error: insErr } = await supabaseAdmin.from("stocktake_lines").insert(rows);
          if (insErr) return err(insErr.message, 500);
        }

        const { error: upErr } = await supabaseAdmin
          .from("stocktakes")
          .update({ status: "submitted", submitted_at: new Date().toISOString() })
          .eq("id", body.stocktake_id);
        if (upErr) return err(upErr.message, 500);

        return ok({
          stocktake_id: body.stocktake_id,
          lines: rows.length,
          diff_total: rows.reduce((a, r) => a + r.diff, 0),
        });
      },
    },
  },
});
