import { createFileRoute } from "@tanstack/react-router";
import type { z } from "zod";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { requireStaffAtDeviceLocation } from "@/server/handheld-fulfillment.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { StocktakeScanReq as Body } from "@/lib/handheld/schemas";
import { classifyStocktakeScan, groupBackfill, normalizeScanEpcs } from "@/lib/handheld/stocktake-scan";

async function loadOpenStocktake(id: string, locationId: string) {
  const { data: st, error } = await supabaseAdmin
    .from("stocktakes")
    .select("id, location_id, status")
    .eq("id", id)
    .maybeSingle();
  if (error) return err(error.message, 500);
  if (!st) return err("Stocktake not found", 404, { code: "not_found" });
  if (st.location_id !== locationId)
    return err("Stocktake location mismatch", 403, { code: "location_forbidden" });
  if (st.status !== "scanning")
    return err(`Stocktake is ${st.status}, not scanning`, 409, { code: "stocktake_closed" });
  return null;
}

export const Route = createFileRoute("/api/public/handheld/stocktake/scan")({
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
          return err("Invalid body", 400, { code: "validation_error", detail: String(e) });
        }

        const closed = await loadOpenStocktake(body.stocktake_id, staff.locationId);
        if (closed) return closed;

        const epcs = normalizeScanEpcs(body.epcs);
        const { data: known, error: knownErr } = await supabaseAdmin
          .from("inv_epcs")
          .select("epc, sku_id")
          .in("epc", epcs);
        if (knownErr) return err(knownErr.message, 500);
        const knownMap = new Map<string, string | null>();
        (known ?? []).forEach((r: { epc: string; sku_id: string | null }) => knownMap.set(r.epc, r.sku_id));

        const rows = epcs.map((epc) => ({
          stocktake_id: body.stocktake_id,
          epc,
          sku_id: knownMap.get(epc) ?? null,
        }));
        const { error } = await supabaseAdmin
          .from("stocktake_scans")
          .upsert(rows, { onConflict: "stocktake_id,epc", ignoreDuplicates: true });
        if (error) return err(error.message, 500);

        // 旧记录 sku_id 为空而 EPC 现已绑定 SKU：只补空值，不覆盖已有关联。
        for (const [skuId, group] of groupBackfill(epcs, knownMap)) {
          const { error: bfErr } = await supabaseAdmin
            .from("stocktake_scans")
            .update({ sku_id: skuId })
            .eq("stocktake_id", body.stocktake_id)
            .in("epc", group)
            .is("sku_id", null);
          if (bfErr) return err(bfErr.message, 500);
        }

        // 以数据库中真实持久化的行为准计算 accepted/unknown，失败不冒充成功。
        const { data: persisted, error: readErr } = await supabaseAdmin
          .from("stocktake_scans")
          .select("epc, sku_id")
          .eq("stocktake_id", body.stocktake_id)
          .in("epc", epcs);
        if (readErr) return err(readErr.message, 500);

        const stillOpen = await loadOpenStocktake(body.stocktake_id, staff.locationId);
        if (stillOpen) return stillOpen;

        return ok(classifyStocktakeScan(epcs, (persisted ?? []) as Array<{ epc: string; sku_id: string | null }>));
      },
    },
  },
});
