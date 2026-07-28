import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  POS_CORS,
  authenticatePosUser,
  hasPosManagerRole,
  posError,
  posJson,
} from "@/server/pos-auth.server";

const ReturnPreviewBody = z.object({
  items: z
    .array(z.object({ order_item_id: z.string().uuid(), quantity: z.number().int().min(1) }))
    .min(1),
});

export const Route = createFileRoute("/api/public/pos/orders/$id/returns/preview")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      POST: async ({ request, params }) => {
        const parsed = ReturnPreviewBody.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return posError("退货商品参数不正确", 400);
        const { data: order, error: orderError } = await supabaseAdmin
          .from("commerce_orders" as never)
          .select("id,sale_location_id,payment_status,order_status,paid_at,total_amount")
          .eq("id", params.id)
          .eq("source_channel", "pos")
          .maybeSingle();
        if (orderError) return posError(orderError.message, 500);
        if (!order) return posError("收银订单不存在", 404);
        const orderRow = order as unknown as {
          sale_location_id: string;
          payment_status: string;
          paid_at: string;
        };
        const auth = await authenticatePosUser(request, orderRow.sale_location_id);
        if (!auth.ok) return auth.response;
        if (orderRow.payment_status !== "paid") return posError("订单当前不可退", 409);

        const itemIds = parsed.data.items.map((item) => item.order_item_id);
        const { data: orderItems, error: itemError } = await supabaseAdmin
          .from("commerce_order_items" as never)
          .select("id,sku_id,title_snapshot,quantity,line_total,epc")
          .eq("order_id", params.id)
          .in("id", itemIds);
        if (itemError) return posError(itemError.message, 500);
        const itemMap = new Map(
          (
            (orderItems ?? []) as unknown as Array<{
              id: string;
              sku_id: string;
              title_snapshot: string;
              quantity: number;
              line_total: number;
              epc: string | null;
            }>
          ).map((item) => [item.id, item]),
        );
        let refundTotal = 0;
        const lines = [];
        for (const requestItem of parsed.data.items) {
          const item = itemMap.get(requestItem.order_item_id);
          if (!item || requestItem.quantity > item.quantity) {
            return posError("退货数量超过原订单", 422, "invalid_return_quantity");
          }
          const refundAmount =
            Math.round((Number(item.line_total) / item.quantity) * requestItem.quantity * 100) /
            100;
          refundTotal += refundAmount;
          lines.push({
            ...requestItem,
            sku_id: item.sku_id,
            title: item.title_snapshot,
            refund_amount: refundAmount,
            inspection_required: Boolean(item.epc),
          });
        }
        const ageHours = (Date.now() - new Date(orderRow.paid_at).getTime()) / (60 * 60 * 1000);
        return posJson({
          ok: true,
          data: {
            lines,
            refund_total: Math.round(refundTotal * 100) / 100,
            requires_authorization: !hasPosManagerRole(auth.roles) || ageHours > 24,
            inspection_required: lines.some((line) => line.inspection_required),
          },
        });
      },
    },
  },
});
