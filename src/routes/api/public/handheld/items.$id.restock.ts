// POST /api/public/handheld/items/{id}/restock
// 已售罄补货：写入库存 + 可选生成打印批次
// Body: { location_id?: uuid, delta: int >=1, print_labels?: boolean, label_template_id?: uuid, note?: string }
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { errCode } from "@/lib/handheld/errors";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildPrintPayload } from "@/server/handheld-print.server";
import { deriveListingStatus, statusLabel } from "@/lib/handheld/listing-status";

const Body = z.object({
  location_id: z.string().uuid().optional(),
  delta: z.number().int().min(1).max(9999),
  print_labels: z.boolean().optional().default(true),
  label_template_id: z.string().uuid().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

export const Route = createFileRoute("/api/public/handheld/items/$id/restock")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch (e) {
          return errCode("invalid_body", undefined, { detail: String(e) });
        }

        const locationId = body.location_id ?? auth.device.location_id;
        if (!locationId) return err("location_id required (device has no bound location)", 400);

        // Verify location exists & active
        const { data: loc } = await supabaseAdmin
          .from("inv_locations")
          .select("id, name, kind, is_active")
          .eq("id", locationId)
          .maybeSingle();
        if (!loc || (loc as { is_active: boolean }).is_active === false) {
          return err("Location not accessible", 403, { code: "location_forbidden" });
        }

        // Load SKU (needed for print payload)
        const { data: sku, error: skuErr } = await supabaseAdmin
          .from("inv_skus")
          .select(
            "id, sku_code, barcode, name, category, price_tier, grade, is_display",
          )
          .eq("id", params.id)
          .maybeSingle();
        if (skuErr) return err(skuErr.message, 500);
        if (!sku) return errCode("not_found", "SKU not found");

        // Apply movement (+delta) — trigger tg_shop_movement_enqueue handles youzan stock push
        const { data: balanceAfter, error: rpcErr } = await supabaseAdmin.rpc(
          "inv_apply_movement",
          {
            p_sku_id: params.id,
            p_location_id: locationId,
            p_delta: body.delta,
            p_ref_type: "handheld_restock",
            p_ref_id: null,
            p_epc: null,
            p_note: body.note ?? "手持机补货",
          } as never,
        );
        if (rpcErr) return err(rpcErr.message, 500);

        // Optional print batch
        let labelBatch: {
          id: string;
          qty: number;
          template_id: string | null;
          print_payload: ReturnType<typeof buildPrintPayload>;
        } | null = null;
        if (body.print_labels) {
          const { data: batch, error: batchErr } = await supabaseAdmin
            .from("inv_label_batches")
            .insert({
              sku_id: params.id,
              qty: body.delta,
              operator: auth.device.device_code ?? auth.device.id,
              notes: `售罄补货 +${body.delta} @ ${(loc as { name: string }).name}`,
            } as never)
            .select("id")
            .single();
          if (batchErr) return err(batchErr.message, 500);
          labelBatch = {
            id: (batch as { id: string }).id,
            qty: body.delta,
            template_id: body.label_template_id ?? null,
            print_payload: buildPrintPayload({
              sku_code: (sku as any).sku_code,
              barcode: (sku as any).barcode ?? null,
              name: (sku as any).name,
              price_tier: (sku as any).price_tier,
              grade: (sku as any).grade,
              condition_grade: (sku as any).grade ?? null,
            }),
          };
        }

        // Recompute total for response
        const { data: stocks } = await supabaseAdmin
          .from("inv_stocks")
          .select("qty")
          .eq("sku_id", params.id);
        const totalQty = (stocks ?? []).reduce(
          (sum, r) => sum + (Number((r as { qty: number }).qty) || 0),
          0,
        );

        const isDisplay = (sku as { is_display?: boolean }).is_display !== false;
        const ls = deriveListingStatus(isDisplay, totalQty);

        return ok({
          sku: {
            id: params.id,
            is_display: isDisplay,
            listing_status: ls,
            status_label: statusLabel(ls),
            total_stock_qty: totalQty,
          },
          movement: {
            delta: body.delta,
            balance_after: (balanceAfter as number) ?? null,
            location_id: locationId,
            location_name: (loc as { name: string }).name,
          },
          label_batch: labelBatch,
        });
      },
    },
  },
});
