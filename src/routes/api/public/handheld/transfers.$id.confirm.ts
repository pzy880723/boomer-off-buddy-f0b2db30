// Unified confirm: dispatches to ship-confirm or receive-confirm based on transfer state.
import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { getTransfer } from "@/server/handheld-transfer.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/handheld/transfers/$id/confirm")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const t = await getTransfer(params.id);
        if (!t) return err("Not found", 404, { code: "not_found" });
        const locId = auth.device.location_id;
        const now = new Date().toISOString();

        const { data: scanned } = await supabaseAdmin
          .from("stock_transfer_epcs")
          .select("epc, sku_id, ship_scanned_at, receive_scanned_at")
          .eq("transfer_id", params.id);

        // SHIP CONFIRM
        if (t.from_location_id === locId && ["draft", "pending", "shipping"].includes(t.status)) {
          const shipBySku = new Map<string, string[]>();
          for (const r of (scanned ?? []) as any[]) {
            if (!r.ship_scanned_at || !r.sku_id) continue;
            const arr = shipBySku.get(r.sku_id) ?? [];
            arr.push(r.epc);
            shipBySku.set(r.sku_id, arr);
          }
          for (const [sku_id, epcs] of shipBySku.entries()) {
            for (const epc of epcs) {
              const { error } = await supabaseAdmin.rpc("inv_apply_movement", {
                p_sku_id: sku_id,
                p_location_id: t.from_location_id!,
                p_delta: -1,
                p_ref_type: "transfer_ship",
                p_ref_id: params.id,
                p_epc: epc,
                p_note: null,
              } as never);
              if (error) return err(`movement failed: ${error.message}`, 500);
              await supabaseAdmin
                .from("inv_epcs")
                .update({ status: "in_transit", last_seen_at: now })
                .eq("epc", epc);
            }
            await supabaseAdmin
              .from("stock_transfer_lines")
              .update({ shipped_qty: epcs.length })
              .eq("transfer_id", params.id)
              .eq("sku_id", sku_id);
          }
          await supabaseAdmin
            .from("stock_transfers")
            .update({ status: "in_transit", shipped_at: now, shipped_by: null })
            .eq("id", params.id);
          return ok({ stage: "shipped", lines: shipBySku.size });
        }

        // RECEIVE CONFIRM
        if (t.to_location_id === locId && ["shipped", "in_transit"].includes(t.status)) {
          const receiveBySku = new Map<string, string[]>();
          const missing: string[] = [];
          for (const r of (scanned ?? []) as any[]) {
            if (!r.ship_scanned_at) continue;
            if (!r.receive_scanned_at) {
              missing.push(r.epc);
              continue;
            }
            if (!r.sku_id) continue;
            const arr = receiveBySku.get(r.sku_id) ?? [];
            arr.push(r.epc);
            receiveBySku.set(r.sku_id, arr);
          }
          if (missing.length)
            return err("Receive mismatch", 422, {
              code: "receive_mismatch",
              missing,
            });
          for (const [sku_id, epcs] of receiveBySku.entries()) {
            for (const epc of epcs) {
              const { error } = await supabaseAdmin.rpc("inv_apply_movement", {
                p_sku_id: sku_id,
                p_location_id: t.to_location_id!,
                p_delta: 1,
                p_ref_type: "transfer_receive",
                p_ref_id: params.id,
                p_epc: epc,
                p_note: null,
              } as never);
              if (error) return err(`movement failed: ${error.message}`, 500);
              await supabaseAdmin
                .from("inv_epcs")
                .update({
                  status: "in_stock",
                  current_location_id: t.to_location_id!,
                  last_seen_at: now,
                })
                .eq("epc", epc);
            }
            await supabaseAdmin
              .from("stock_transfer_lines")
              .update({ received_qty: epcs.length })
              .eq("transfer_id", params.id)
              .eq("sku_id", sku_id);
          }
          await supabaseAdmin
            .from("stock_transfers")
            .update({ status: "received", received_at: now })
            .eq("id", params.id);
          return ok({ stage: "received", lines: receiveBySku.size });
        }

        return err(`Cannot confirm transfer ${t.status} from this location`, 409, {
          code: "wrong_stage",
        });
      },
    },
  },
});
