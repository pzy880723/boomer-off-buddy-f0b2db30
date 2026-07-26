import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

const CloseShiftBody = z.object({
  counted_cash: z.number().min(0).max(1_000_000),
  note: z.string().trim().max(500).optional(),
});

export const Route = createFileRoute("/api/public/pos/shifts/$id/close")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      POST: async ({ request, params }) => {
        let body: z.infer<typeof CloseShiftBody>;
        try {
          body = CloseShiftBody.parse(await request.json());
        } catch (error) {
          return posError(`参数错误：${String(error)}`, 400);
        }
        const { data: shift, error: shiftError } = await supabaseAdmin
          .from("pos_shifts" as never)
          .select("id,location_id,operator_id,status,opening_cash")
          .eq("id", params.id)
          .maybeSingle();
        if (shiftError) return posError(shiftError.message, 500);
        if (!shift) return posError("收银班次不存在", 404, "shift_not_found");
        const shiftRow = shift as unknown as {
          location_id: string;
          operator_id: string;
          status: string;
          opening_cash: number;
        };
        const auth = await authenticatePosUser(request, shiftRow.location_id);
        if (!auth.ok) return auth.response;
        if (shiftRow.operator_id !== auth.user.id && !auth.roles.includes("super_admin")) {
          return posError("不能关闭其他员工的班次", 403, "shift_forbidden");
        }
        if (shiftRow.status === "closed") return posJson({ ok: true, data: shift, replayed: true });
        const { data: movements, error: movementError } = await supabaseAdmin
          .from("pos_cash_movements" as never)
          .select("amount")
          .eq("shift_id", params.id);
        if (movementError) return posError(movementError.message, 500);
        const expectedCash =
          Number(shiftRow.opening_cash) +
          ((movements ?? []) as unknown as Array<{ amount: number }>).reduce(
            (sum, movement) => sum + Number(movement.amount),
            0,
          );
        const difference = Math.round((body.counted_cash - expectedCash) * 100) / 100;
        const { data: closed, error: closeError } = await supabaseAdmin
          .from("pos_shifts" as never)
          .update({
            status: "closed",
            expected_cash: expectedCash,
            counted_cash: body.counted_cash,
            cash_difference: difference,
            close_note: body.note ?? null,
            closed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          } as never)
          .eq("id", params.id)
          .neq("status", "closed")
          .select("*")
          .single();
        if (closeError) return posError(closeError.message, 500);
        return posJson({ ok: true, data: closed });
      },
    },
  },
});
