import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

const CashMovementQuery = z.object({
  shift_id: z.string().uuid(),
});

const CashMovementBody = z.object({
  shift_id: z.string().uuid(),
  type: z.enum(["cash_in", "cash_out"]),
  amount: z.number().positive().max(1_000_000),
  reason: z.string().trim().min(1).max(200),
});

type ShiftRow = {
  id: string;
  location_id: string;
  operator_id: string;
  status: "open" | "closing" | "closed";
  opening_cash: number;
};

async function loadAuthorizedShift(request: Request, shiftId: string) {
  const { data, error } = await supabaseAdmin
    .from("pos_shifts" as never)
    .select("id,location_id,operator_id,status,opening_cash")
    .eq("id", shiftId)
    .maybeSingle();
  if (error) return { ok: false as const, response: posError(error.message, 500) };
  if (!data) return { ok: false as const, response: posError("钱箱不存在", 404, "not_found") };

  const shift = data as unknown as ShiftRow;
  const auth = await authenticatePosUser(request, shift.location_id);
  if (!auth.ok) return auth;
  if (shift.operator_id !== auth.user.id) {
    return {
      ok: false as const,
      response: posError("当前钱箱由其他员工使用", 403, "shift_operator_mismatch"),
    };
  }
  if (shift.status !== "open") {
    return {
      ok: false as const,
      response: posError("当前钱箱不可操作", 409, "shift_not_open"),
    };
  }
  return { ok: true as const, shift, auth };
}

export const Route = createFileRoute("/api/public/pos/cash-movements")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      GET: async ({ request }) => {
        let query: z.infer<typeof CashMovementQuery>;
        try {
          query = CashMovementQuery.parse(
            Object.fromEntries(new URL(request.url).searchParams.entries()),
          );
        } catch (error) {
          return posError(`参数错误：${String(error)}`, 400);
        }

        const access = await loadAuthorizedShift(request, query.shift_id);
        if (!access.ok) return access.response;

        const { data, error } = await supabaseAdmin
          .from("pos_cash_movements" as never)
          .select("id,type,amount,reason,order_id,created_at")
          .eq("shift_id", query.shift_id)
          .order("created_at", { ascending: false });
        if (error) return posError(error.message, 500);

        const items = (data ?? []) as unknown as Array<{
          id: string;
          type: string;
          amount: number;
          reason: string | null;
          order_id: string | null;
          created_at: string;
        }>;
        const balance =
          Number(access.shift.opening_cash) +
          items.reduce((sum, item) => sum + Number(item.amount), 0);

        return posJson({
          ok: true,
          data: {
            opening_cash: Number(access.shift.opening_cash),
            balance,
            items,
          },
        });
      },
      POST: async ({ request }) => {
        let body: z.infer<typeof CashMovementBody>;
        try {
          body = CashMovementBody.parse(await request.json());
        } catch (error) {
          return posError(`参数错误：${String(error)}`, 400);
        }

        const access = await loadAuthorizedShift(request, body.shift_id);
        if (!access.ok) return access.response;

        const { data, error } = await supabaseAdmin.rpc(
          "pos_record_cash_adjustment" as never,
          {
            p_shift_id: body.shift_id,
            p_operator_id: access.auth.user.id,
            p_type: body.type,
            p_amount: body.amount,
            p_reason: body.reason,
          } as never,
        );
        if (error) {
          if (error.message.includes("insufficient_drawer_balance")) {
            return posError("取出金额不能超过钱箱余额", 409, "insufficient_drawer_balance");
          }
          return posError(error.message, 409, "cash_adjustment_failed");
        }
        return posJson({ ok: true, data }, { status: 201 });
      },
    },
  },
});
