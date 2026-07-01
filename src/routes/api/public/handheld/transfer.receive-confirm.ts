import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice } from "@/server/handheld-auth.server";
import { ConfirmBody, getTransfer, ok, err } from "@/server/handheld-transfer.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enqueueStockPushForLocation } from "@/lib/youzan-sync.functions";

export const Route = createFileRoute("/api/public/handheld/transfer/receive-confirm")({
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
        if (t.to_location_id !== auth.device.location_id) return err("Location mismatch", 403);
        if (t.status !== "in_transit") return err(`Already ${t.status}`, 409);

        const { data: scanned } = await supabaseAdmin
          .from("stock_transfer_epcs")
          .select("epc, sku_id, ship_scanned_at, receive_scanned_at")
          .eq("transfer_id", body.transfer_id);

        const issues: string[] = [];
        const receiveBySku = new Map<string, string[]>();
        const missingReceive: string[] = [];
        for (const r of scanned ?? []) {
          const row = r as any;
          if (!row.ship_scanned_at) continue;
          if (!row.receive_scanned_at) {
            missingReceive.push(row.epc);
            continue;
          }
          if (!row.sku_id) continue;
          const arr = receiveBySku.get(row.sku_id) ?? [];
          arr.push(row.epc);
          receiveBySku.set(row.sku_id, arr);
        }
        if (missingReceive.length)
          issues.push(`${missingReceive.length} shipped EPC not yet received`);
        if (issues.length) return err("Receive mismatch", 422, { issues, missingReceive });

        for (const [sku_id, epcs] of receiveBySku.entries()) {
          for (const epc of epcs) {
            const { error } = await supabaseAdmin.rpc("inv_apply_movement", {
              p_sku_id: sku_id,
              p_location_id: t.to_location_id!,
              p_delta: 1,
              p_ref_type: "transfer_receive",
              p_ref_id: body.transfer_id,
              p_epc: epc,
              p_note: null,
            } as never);
            if (error) return err(`movement failed: ${error.message}`, 500);
            await supabaseAdmin
              .from("inv_epcs")
              .update({
                status: "in_stock",
                current_location_id: t.to_location_id!,
                last_seen_at: new Date().toISOString(),
              })
              .eq("epc", epc);
          }
          await supabaseAdmin
            .from("stock_transfer_lines")
            .update({ received_qty: epcs.length })
            .eq("transfer_id", body.transfer_id)
            .eq("sku_id", sku_id);
        }

        await supabaseAdmin
          .from("stock_transfers")
          .update({ status: "received", received_at: new Date().toISOString() })
          .eq("id", body.transfer_id);

        // 收货成功：目标库位 +N（推分店），源库位在发货时已推过（推 HQ）；
        // 为保证收货后 HQ / 分店都是"账实一致"，两边都再推一次。
        for (const sku_id of receiveBySku.keys()) {
          try {
            await enqueueStockPushForLocation(sku_id, t.to_location_id!, "transfer_receive");
            await enqueueStockPushForLocation(sku_id, t.from_location_id!, "transfer_receive_src");
          } catch {}
        }


        return ok({ transfer_id: body.transfer_id, received: scanned?.length ?? 0 });
      },
    },
  },
});
