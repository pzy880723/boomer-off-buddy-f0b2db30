import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  HANDHELD_CORS,
  authenticateDevice,
  requireLocation,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { requireStaffAtDeviceLocation } from "@/server/handheld-fulfillment.server";

const Body = z.object({
  fulfillment_item_id: z.string().uuid(),
  quantity: z.number().int().positive().max(999),
  reason: z.string().trim().min(1).max(400),
  client_op_id: z.string().trim().min(1).max(120),
});

const SELECT =
  "id, fulfillment_id, fulfillment_item_id, quantity, reason, status, refund_state, created_at";

export const Route = createFileRoute("/api/public/handheld/fulfillments/$id/shortage")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const location = requireLocation(auth.device);
        if (!location.ok) return location.response;
        const session = await resolveSessionUser(request);
        const staff = await requireStaffAtDeviceLocation(auth.device, session);
        if (!staff.ok) return staff.response;
        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch (error) {
          return err(`Invalid body: ${String(error)}`, 400, { code: "validation_error" });
        }

        const { data: fulfillment } = await supabaseAdmin
          .from("fulfillments" as never)
          .select("id, order_id, location_id")
          .eq("id", params.id)
          .eq("location_id", staff.locationId)
          .maybeSingle();
        if (!fulfillment) return err("Fulfillment not found", 404, { code: "not_found" });
        const row = fulfillment as unknown as { id: string; order_id: string };

        const { data: item } = await supabaseAdmin
          .from("fulfillment_items" as never)
          .select("id, expected_qty, picked_qty")
          .eq("id", body.fulfillment_item_id)
          .eq("fulfillment_id", params.id)
          .maybeSingle();
        if (!item) return err("Line does not belong to this fulfillment", 409, { code: "line_mismatch" });

        const existing = await supabaseAdmin
          .from("fulfillment_shortages" as never)
          .select(SELECT)
          .eq("fulfillment_id", params.id)
          .eq("client_op_id", body.client_op_id)
          .maybeSingle();
        if (existing.data) return ok({ shortage: existing.data, replayed: true });

        const { data: exception } = await supabaseAdmin
          .from("fulfillment_exceptions" as never)
          .insert({
            fulfillment_id: params.id,
            fulfillment_item_id: body.fulfillment_item_id,
            kind: "shortage",
            description: body.reason,
            status: "open",
            reported_by: staff.userId,
          } as never)
          .select("id")
          .maybeSingle();

        const { data, error } = await supabaseAdmin
          .from("fulfillment_shortages" as never)
          .insert({
            fulfillment_id: params.id,
            fulfillment_item_id: body.fulfillment_item_id,
            exception_id: (exception as { id: string } | null)?.id ?? null,
            order_id: row.order_id,
            quantity: body.quantity,
            reason: body.reason,
            status: "pending_customer",
            // 已付款订单缺货必须走真实退款流程，先冻结为待退款
            refund_state: "refund_pending",
            reported_by: staff.userId,
            device_id: auth.device.id,
            client_op_id: body.client_op_id,
          } as never)
          .select(SELECT)
          .single();
        if (error) return err(error.message, 409);
        return ok({ shortage: data, replayed: false, blocks_completion: true });
      },
    },
  },
});
