import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice } from "@/server/handheld-auth.server";
import { ConfirmBody, getTransfer, ok, err } from "@/server/handheld-transfer.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enqueueStockPushForLocation } from "@/lib/youzan-sync.functions";

export const Route = createFileRoute("/api/public/handheld/transfer/ship-confirm")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        let body;
        try {
          body = ConfirmBody.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { detail: String(e) });
        }
        const t = await getTransfer(body.transfer_id);
        if (!t) return err("Not found", 404);
        if (t.from_location_id !== auth.device.location_id) return err("Location mismatch", 403);
        if (t.status !== "draft") return err(`Already ${t.status}`, 409);

        // Aggregate scanned epcs by sku
        const { data: scanned } = await supabaseAdmin
          .from("stock_transfer_epcs")
          .select("epc, sku_id, ship_scanned_at")
          .eq("transfer_id", body.transfer_id)
          .not("ship_scanned_at", "is", null);

        const shippedBySku = new Map<string, string[]>();
        (scanned ?? []).forEach((r: any) => {
          if (!r.sku_id) return;
          const arr = shippedBySku.get(r.sku_id) ?? [];
          arr.push(r.epc);
          shippedBySku.set(r.sku_id, arr);
        });

        // Validate counts against expected
        const issues: string[] = [];
        const lines = (t as any).lines as { sku_id: string; expected_qty: number }[];
        for (const line of lines) {
          const have = shippedBySku.get(line.sku_id)?.length ?? 0;
          if (have !== line.expected_qty)
            issues.push(`sku ${line.sku_id}: scanned ${have} ≠ expected ${line.expected_qty}`);
        }
        const unknownScans = (scanned ?? []).filter((r: any) => !r.sku_id).length;
        if (unknownScans) issues.push(`${unknownScans} unknown EPC scans`);
        if (issues.length) return err("Scan count mismatch", 422, { issues });

        // Apply -1 movements on from_location
        for (const [sku_id, epcs] of shippedBySku.entries()) {
          for (const epc of epcs) {
            const { error } = await supabaseAdmin.rpc("inv_apply_movement", {
              p_sku_id: sku_id,
              p_location_id: t.from_location_id!,
              p_delta: -1,
              p_ref_type: "transfer_ship",
              p_ref_id: body.transfer_id,
              p_epc: epc,
              p_note: null,
            } as never);
            if (error) return err(`movement failed: ${error.message}`, 500);
            await supabaseAdmin
              .from("inv_epcs")
              .update({
                status: "in_transit",
                current_location_id: null,
                last_seen_at: new Date().toISOString(),
              })
              .eq("epc", epc);
          }
          await supabaseAdmin
            .from("stock_transfer_lines")
            .update({ shipped_qty: epcs.length })
            .eq("transfer_id", body.transfer_id)
            .eq("sku_id", sku_id);
        }

        await supabaseAdmin
          .from("stock_transfers")
          .update({
            status: "in_transit",
            shipped_at: new Date().toISOString(),
          })
          .eq("id", body.transfer_id);

        // 发货完成 → 源库位库存减少，需要推有赞
        for (const sku_id of shippedBySku.keys()) {
          try {
            await enqueueStockPushForLocation(sku_id, t.from_location_id!, "transfer_ship");
          } catch {}
        }

        return ok({ transfer_id: body.transfer_id, shipped: scanned?.length ?? 0 });
      },
    },
  },
});
