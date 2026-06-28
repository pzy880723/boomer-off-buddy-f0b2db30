import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  ok,
  err,
  resolveSessionUser,
} from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { SmartCreateReq } from "@/lib/handheld/schemas";
import { generateEpc, generateSkuCode } from "@/lib/inventory.helpers";
import { buildPrintPayload } from "@/server/handheld-print.server";
import { replayIfPresent, recordOp, jsonReplay } from "@/server/handheld-idempotency.server";

export const Route = createFileRoute("/api/public/handheld/items/smart-create")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        let body: ReturnType<typeof SmartCreateReq.parse>;
        try {
          body = SmartCreateReq.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { detail: String(e) });
        }
        const session = await resolveSessionUser(request);
        const locationId = body.location_id ?? auth.device.location_id;
        if (!locationId) return err("No target location (device unbound and no location_id given)", 400);

        const { data: loc } = await supabaseAdmin
          .from("inv_locations")
          .select("id, name, kind, is_active")
          .eq("id", locationId)
          .maybeSingle();
        if (!loc || !loc.is_active) return err("Location not found or disabled", 404);

        // Reuse existing SKU if (category, price_tier, name) already exists; else create.
        const { data: existSku } = await supabaseAdmin
          .from("inv_skus")
          .select("id, sku_code, epc, stock_qty")
          .eq("category", body.category)
          .eq("price_tier", body.price_tier)
          .eq("name", body.name)
          .maybeSingle();

        let skuId: string;
        let skuCode: string;
        let epc: string;
        if (existSku) {
          skuId = existSku.id;
          skuCode = existSku.sku_code ?? generateSkuCode(body.category, "single");
          epc = existSku.epc;
        } else {
          skuCode = generateSkuCode(body.category, "single");
          epc = generateEpc(body.category, body.price_tier);
          const ins = await supabaseAdmin
            .from("inv_skus")
            .insert({
              category: body.category,
              name: body.name,
              price_tier: body.price_tier,
              is_custom_price: body.is_custom_price,
              kind: "single",
              epc,
              sku_code: skuCode,
              image_url: body.image_url ?? null,
              weight_g: body.weight_g ?? null,
              notes: body.notes ?? null,
              grade: body.grade ?? null,
              stock_qty: 0,
              status: "active",
            })
            .select("id, sku_code, epc, barcode, grade")
            .single();
          if (ins.error || !ins.data) return err(`Create SKU failed: ${ins.error?.message}`, 500);
          skuId = ins.data.id;
          skuCode = ins.data.sku_code ?? skuCode;
          epc = ins.data.epc;
        }

        // Bind extra EPCs (if APP scanned labels already)
        let boundCount = 0;
        for (const e of body.epcs ?? []) {
          const upsertEpc = await supabaseAdmin
            .from("inv_epcs")
            .upsert(
              {
                epc: e,
                sku_id: skuId,
                status: "in_stock",
                current_location_id: locationId,
                last_seen_at: new Date().toISOString(),
              },
              { onConflict: "epc" },
            );
          if (!upsertEpc.error) boundCount++;
        }

        // +1 movement at the chosen location (and warehouse stock_qty if warehouse)
        const mv = await supabaseAdmin.rpc("inv_apply_movement", {
          p_sku_id: skuId,
          p_location_id: locationId,
          p_delta: 1 + boundCount,
          p_ref_type: "handheld_smart_create",
          p_epc: epc,
          p_note: `device:${auth.device.device_code}${session ? ` user:${session.email ?? session.user_id}` : ""}`,
        } as never);
        if (mv.error) return err(`Stock movement failed: ${mv.error.message}`, 500);

        // Youzan sync queue
        let syncStatus: "disabled" | "queued" | "linked" | "unlinked" = "disabled";
        if (body.auto_push_youzan) {
          const { data: links } = await supabaseAdmin
            .from("sku_youzan_links")
            .select("id")
            .eq("sku_id", skuId)
            .limit(1);
          if (links && links.length > 0) {
            const { data: skuRow } = await supabaseAdmin
              .from("inv_skus")
              .select("stock_qty")
              .eq("id", skuId)
              .maybeSingle();
            await supabaseAdmin.from("youzan_stock_sync_queue").insert({
              sku_id: skuId,
              target_stock: skuRow?.stock_qty ?? 0,
              reason: "handheld_smart_create",
              status: "pending",
            });
            syncStatus = "queued";
          } else {
            syncStatus = "unlinked";
          }
        }

        const { data: finalSku } = await supabaseAdmin
          .from("inv_skus")
          .select("stock_qty, barcode, grade")
          .eq("id", skuId)
          .maybeSingle();

        const barcode = (finalSku as any)?.barcode ?? null;
        const conditionGrade = ((finalSku as any)?.grade ?? body.grade ?? null) as
          | "N" | "S" | "A" | "B" | "C" | "J" | null;

        return ok({
          sku_id: skuId,
          sku_code: skuCode,
          barcode,
          epc,
          condition_grade: conditionGrade,
          stock_qty: finalSku?.stock_qty ?? 0,
          bound_epcs: boundCount,
          label: {
            sku_code: skuCode,
            barcode,
            epc,
            name: body.name,
            price_cny: body.price_tier,
            grade: body.grade ?? null,
            condition_grade: conditionGrade,
            location_name: loc.name,
            qrcode_payload: `vg://sku/${skuId}`,
          },
          youzan_sync_status: syncStatus,
        });
      },
    },
  },
});
