import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

export const Route = createFileRoute("/api/public/pos/sales/$id/receipt")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      GET: async ({ request, params }) => {
        const { data: order, error: orderError } = await supabaseAdmin
          .from("commerce_orders" as never)
          .select("id,order_no,sale_location_id,total_amount,paid_at,completed_at,source_channel")
          .eq("id", params.id)
          .eq("source_channel", "pos")
          .maybeSingle();
        if (orderError) return posError(orderError.message, 500);
        if (!order) return posError("收银订单不存在", 404, "sale_not_found");
        const orderRow = order as unknown as {
          id: string;
          order_no: string;
          sale_location_id: string;
          total_amount: number;
          paid_at: string;
          completed_at: string;
        };
        const auth = await authenticatePosUser(request, orderRow.sale_location_id);
        if (!auth.ok) return auth.response;

        const [receiptResult, itemsResult, paymentsResult, locationResult] = await Promise.all([
          supabaseAdmin
            .from("pos_receipts" as never)
            .select("receipt_no,print_count,created_at")
            .eq("order_id", params.id)
            .single(),
          supabaseAdmin
            .from("commerce_order_items" as never)
            .select("sku_id,title_snapshot,unit_price,quantity,line_total")
            .eq("order_id", params.id)
            .order("created_at", { ascending: true }),
          supabaseAdmin
            .from("commerce_payments" as never)
            .select("provider,amount,provider_transaction_id")
            .eq("order_id", params.id)
            .eq("status", "succeeded"),
          supabaseAdmin
            .from("inv_locations")
            .select("id,name")
            .eq("id", orderRow.sale_location_id)
            .single(),
        ]);
        const firstError =
          receiptResult.error || itemsResult.error || paymentsResult.error || locationResult.error;
        if (firstError) return posError(firstError.message, 500);

        return posJson({
          ok: true,
          data: {
            order_id: orderRow.id,
            order_no: orderRow.order_no,
            receipt_no: (receiptResult.data as unknown as { receipt_no: string }).receipt_no,
            location_name: (locationResult.data as unknown as { name: string }).name,
            total_amount: Number(orderRow.total_amount),
            paid_at: orderRow.paid_at ?? orderRow.completed_at,
            items: itemsResult.data ?? [],
            payments: paymentsResult.data ?? [],
          },
        });
      },
      POST: async ({ request, params }) => {
        const { data: receipt, error: receiptError } = await supabaseAdmin
          .from("pos_receipts" as never)
          .select("order_id,print_count")
          .eq("order_id", params.id)
          .maybeSingle();
        if (receiptError) return posError(receiptError.message, 500);
        if (!receipt) return posError("收银小票不存在", 404, "receipt_not_found");
        const { data: order, error: orderError } = await supabaseAdmin
          .from("commerce_orders" as never)
          .select("sale_location_id")
          .eq("id", params.id)
          .single();
        if (orderError) return posError(orderError.message, 500);
        const auth = await authenticatePosUser(
          request,
          (order as unknown as { sale_location_id: string }).sale_location_id,
        );
        if (!auth.ok) return auth.response;
        const printCount = Number((receipt as unknown as { print_count: number }).print_count) + 1;
        const { error: updateError } = await supabaseAdmin
          .from("pos_receipts" as never)
          .update({
            print_count: printCount,
            last_printed_at: new Date().toISOString(),
          } as never)
          .eq("order_id", params.id);
        if (updateError) return posError(updateError.message, 500);
        return posJson({ ok: true, data: { print_count: printCount } });
      },
    },
  },
});
