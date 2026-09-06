import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";

const Body = z.object({
  // accept = 同意缺货并等待退款；cancel = 取消该商品并要求退款
  action: z.enum(["accept", "cancel"]),
  note: z.string().trim().max(400).optional(),
});

export const Route = createFileRoute("/api/public/storefront/shortages/$id/respond")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch (error) {
          return storefrontError(`Invalid body: ${String(error)}`, 400, "validation_error");
        }
        const { data: shortage } = await supabaseAdmin
          .from("fulfillment_shortages" as never)
          .select("id, order_id, status, refund_state")
          .eq("id", params.id)
          .maybeSingle();
        if (!shortage) return storefrontError("Shortage not found", 404, "not_found");
        const row = shortage as unknown as {
          id: string;
          order_id: string | null;
          status: string;
          refund_state: string;
        };
        // 只有订单本人可以确认，员工不得代替客户确认
        const { data: order } = await supabaseAdmin
          .from("commerce_orders" as never)
          .select("id")
          .eq("id", row.order_id ?? "")
          .eq("customer_id", auth.customer.id)
          .maybeSingle();
        if (!order) return storefrontError("Shortage not found", 404, "not_found");
        if (row.status !== "pending_customer") {
          return storefrontJson({
            ok: true,
            data: { shortage: row, replayed: true },
          });
        }
        const { data, error } = await supabaseAdmin
          .from("fulfillment_shortages" as never)
          .update({
            status: body.action === "accept" ? "customer_accepted" : "customer_cancelled",
            customer_responded_at: new Date().toISOString(),
            customer_response_note: body.note ?? null,
            updated_at: new Date().toISOString(),
          } as never)
          .eq("id", params.id)
          .eq("status", "pending_customer")
          .select("id, status, refund_state, customer_responded_at")
          .single();
        if (error) return storefrontError(error.message, 500);
        // refund_state 仍为 refund_pending：必须真实退款完成后由财务流程改写，不在此伪造退款成功
        return storefrontJson({ ok: true, data: { shortage: data, replayed: false } });
      },
    },
  },
});
