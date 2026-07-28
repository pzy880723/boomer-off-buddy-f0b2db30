import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

const ReturnBody = z.object({
  shift_id: z.string().uuid(),
  client_op_id: z.string().trim().min(8).max(100),
  reason: z.string().trim().min(2).max(200),
  authorization_id: z.string().uuid().nullable().optional(),
  items: z
    .array(z.object({ order_item_id: z.string().uuid(), quantity: z.number().int().min(1) }))
    .min(1),
});

export const Route = createFileRoute("/api/public/pos/orders/$id/returns")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      POST: async ({ request, params }) => {
        const parsed = ReturnBody.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return posError("退货参数不正确", 400);
        const { data: shift, error: shiftError } = await supabaseAdmin
          .from("pos_shifts" as never)
          .select("id,location_id,operator_id,status")
          .eq("id", parsed.data.shift_id)
          .maybeSingle();
        if (shiftError) return posError(shiftError.message, 500);
        if (!shift) return posError("收银班次不存在", 404);
        const shiftRow = shift as unknown as { location_id: string; operator_id: string };
        const auth = await authenticatePosUser(request, shiftRow.location_id);
        if (!auth.ok) return auth.response;
        if (shiftRow.operator_id !== auth.user.id) {
          return posError("不能使用其他员工的班次", 403);
        }
        const { data, error } = await supabaseAdmin.rpc(
          "pos_complete_return" as never,
          {
            p_shift_id: parsed.data.shift_id,
            p_operator_id: auth.user.id,
            p_order_id: params.id,
            p_client_op_id: parsed.data.client_op_id,
            p_items: parsed.data.items,
            p_reason: parsed.data.reason,
            p_authorization_id: parsed.data.authorization_id ?? null,
          } as never,
        );
        if (error) {
          const conflict = /return|order|shift|quantity|authorization/i.test(error.message);
          return posError(
            error.message,
            conflict ? 409 : 500,
            conflict ? "return_conflict" : undefined,
          );
        }
        return posJson({ ok: true, data }, { status: 201 });
      },
    },
  },
});
