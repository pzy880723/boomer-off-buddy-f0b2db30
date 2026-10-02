import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  calculatePointsReturnPreview,
  type PointsReturnHistory,
  type PointsReturnItem,
} from "@/lib/pos/points-return-preview";
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
          .select("id,sale_location_id,payment_status,order_status,paid_at,total_amount,benefit_snapshot")
          .eq("id", params.id)
          .eq("source_channel", "pos")
          .maybeSingle();
        if (orderError) return posError(orderError.message, 500);
        if (!order) return posError("收银订单不存在", 404);
        const orderRow = order as unknown as {
          sale_location_id: string;
          payment_status: string;
          paid_at: string;
          benefit_snapshot: Record<string, unknown> | null;
        };
        const auth = await authenticatePosUser(request, orderRow.sale_location_id);
        if (!auth.ok) return auth.response;
        if (orderRow.payment_status !== "paid") return posError("订单当前不可退", 409);

        const itemIds = parsed.data.items.map((item) => item.order_item_id);
        const { data: orderItems, error: itemError } = await supabaseAdmin
          .from("commerce_order_items" as never)
          .select("id,sku_id,title_snapshot,quantity,line_total,epc,discount_snapshot")
          .eq("order_id", params.id)
          .in("id", itemIds);
        if (itemError) return posError(itemError.message, 500);
        const pointsOrder = Object.prototype.hasOwnProperty.call(
          orderRow.benefit_snapshot ?? {}, "points_redemption",
        );
        const history: PointsReturnHistory[] = [];
        if (pointsOrder) {
          // Page all history: truncation would overstate the remaining refund entitlement.
          const pageSize = 1000;
          for (let offset = 0; ;) {
            const { data, error } = await supabaseAdmin
              .from("pos_return_items" as never)
              .select("order_item_id,quantity,sale_return:pos_returns!inner(order_id,status,completed_at)")
              .eq("sale_return.order_id", params.id)
              .in("order_item_id", itemIds)
              .order("id", { ascending: true })
              .range(offset, offset + pageSize - 1);
            if (error) return posError(error.message, 500);
            const page = (data ?? []) as unknown as PointsReturnHistory[];
            if (page.length === 0) break;
            history.push(...page);
            offset += page.length;
          }
        }
        let preview;
        try {
          preview = calculatePointsReturnPreview(
            pointsOrder, parsed.data.items, (orderItems ?? []) as unknown as PointsReturnItem[], history,
          );
        } catch (error) {
          if (error instanceof Error && error.message === "invalid_return_quantity") {
            return posError("退货数量超过原订单", 422, "invalid_return_quantity");
          }
          return posError("退货金额或积分记录无效，请刷新后重试", 422, "invalid_return_snapshot");
        }
        const ageHours = (Date.now() - new Date(orderRow.paid_at).getTime()) / (60 * 60 * 1000);
        return posJson({
          ok: true,
          data: {
            ...preview,
            requires_authorization: !hasPosManagerRole(auth.roles) || ageHours > 24,
            inspection_required: preview.lines.some((line) => line.inspection_required),
          },
        });
      },
    },
  },
});
