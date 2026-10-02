import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { SaleRecoveryRequest, SaleRecoveryResult } from "@/lib/pos/sale-recovery";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

export const Route = createFileRoute("/api/public/pos/sales/recover/cancel")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticatePosUser(request);
        if (!auth.ok) return auth.response;
        let body;
        try {
          body = SaleRecoveryRequest.parse(await request.json());
        } catch {
          return posError("请提供原收款的班次和操作编号", 400, "invalid_recovery_request");
        }
        const { data: shift, error: shiftError } = await supabaseAdmin
          .from("pos_shifts" as never)
          .select("id,location_id,operator_id")
          .eq("id", body.shift_id)
          .maybeSingle();
        if (shiftError)
          return posError("暂时无法核对原班次，请保留待确认记录", 503, "sale_recovery_unavailable");
        if (!shift) return posError("原收银班次不存在，请保留待确认记录", 404, "shift_not_found");
        const row = shift as unknown as { location_id: string; operator_id: string };
        if (!auth.locations.some((location) => location.id === row.location_id)) {
          return posError("无权核对该门店收款", 403, "location_forbidden");
        }
        if (row.operator_id !== auth.user.id) {
          return posError("只能核对本人原班次的收款", 403, "shift_forbidden");
        }
        // Never clear a client record based on an unlocked order lookup. The RPC
        // returns an order or commits a tombstone under the same lock as v2/v3.
        const { data, error } = await supabaseAdmin.rpc(
          "pos_recover_sale_cancel" as never,
          {
            p_shift_id: body.shift_id,
            p_operator_id: auth.user.id,
            p_client_op_id: body.client_op_id,
          } as never,
        );
        if (error) {
          if (error.message === "idempotency_conflict")
            return posError("操作编号与原班次不匹配", 409, "idempotency_conflict");
          if (error.message === "shift_forbidden")
            return posError("只能核对本人原班次的收款", 403, "shift_forbidden");
          if (error.message === "shift_not_found")
            return posError("原收银班次不存在", 404, "shift_not_found");
          return posError(
            "收款安全核对暂不可用，请保留待确认记录后重试",
            503,
            "sale_recovery_unavailable",
          );
        }
        const result = SaleRecoveryResult.safeParse(data);
        if (!result.success || result.data.client_op_id !== body.client_op_id) {
          return posError("核对结果异常，请保留待确认记录", 503, "sale_recovery_unavailable");
        }
        return posJson({ ok: true, data: result.data });
      },
    },
  },
});
