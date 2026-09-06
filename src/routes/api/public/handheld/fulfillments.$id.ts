import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import {
  FULFILLMENT_WORKFLOW_VERSION,
  authorizeFulfillment,
  evaluateFulfillmentAccess,
  loadPickGuard,
} from "@/server/handheld-fulfillment-access.server";

export const Route = createFileRoute("/api/public/handheld/fulfillments/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        // 读授权：普通员工限设备当前库位；HQ 按目标子单库位授权。
        const access = await authorizeFulfillment({
          device: auth.device,
          session,
          fulfillmentId: params.id,
          mode: "read",
        });
        if (!access.ok) return access.response;

        const { data, error } = await supabaseAdmin
          .from("fulfillments" as never)
          .select(
            "*, order:commerce_orders!order_id(order_no, order_status, payment_status, recipient_name, recipient_phone, shipping_address, courier_provider, courier_service_code, customer_note), location:inv_locations!location_id(id,name,kind), tote:warehouse_totes!tote_id(id,code,status), items:fulfillment_items(*, order_item:commerce_order_items!order_item_id(title_snapshot,image_snapshot,condition_snapshot,unit_price), sku:inv_skus!sku_id(sku_code,barcode,name,image_url))",
          )
          .eq("id", params.id)
          .maybeSingle();
        if (error) return err(error.message, 500);
        if (!data) return err("Fulfillment not found", 404, { code: "not_found" });

        // 写能力必须是服务端真实判定，不是 UI 声明。
        const writeDecision = evaluateFulfillmentAccess({
          mode: "write",
          isHq: access.isHq,
          deviceLocationId: auth.device.location_id ?? null,
          fulfillmentLocationId: access.fulfillment.location_id,
          userAllowedAtFulfillmentLocation: true,
          orderStatus: access.fulfillment.order_status,
        });
        const { guard, shortageByItem } = await loadPickGuard(access.fulfillment);

        const row = data as unknown as {
          items?: Array<{ id: string }> | null;
          [key: string]: unknown;
        };
        const items = (row.items ?? []).map((item) => {
          const shortage = shortageByItem.get(item.id);
          return {
            ...item,
            shortage_status: shortage?.status ?? null,
            shortage_refund_state: shortage?.refund_state ?? null,
          };
        });

        return ok({
          ...row,
          items,
          workflow_version: FULFILLMENT_WORKFLOW_VERSION,
          scope: access.scope,
          can_write: writeDecision.ok,
          write_blocked_reason: writeDecision.ok ? null : writeDecision.code,
          can_complete_pick: guard.can_complete_pick,
          complete_pick_blocked_reasons: guard.blocked_reasons,
          unpicked_line_count: guard.unpicked_line_count,
          pending_customer_count: guard.pending_customer_count,
          refund_pending_count: guard.refund_pending_count,
          // 尚未对接真实快递商户与电子面单账号，能力恒为 false，不返回伪造运单号。
          waybill_available: false,
        });
      },
    },
  },
});
