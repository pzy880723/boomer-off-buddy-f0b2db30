import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

const SaleBody = z.object({
  shift_id: z.string().uuid(),
  client_op_id: z.string().trim().min(8).max(100),
  items: z
    .array(
      z.object({
        sku_id: z.string().uuid(),
        quantity: z.number().int().min(1).max(999),
        subcategory_code: z.string().trim().min(1).max(80).nullable().optional(),
      }),
    )
    .min(1)
    .max(100),
  tenders: z
    .array(
      z.object({
        provider: z.enum(["cash", "wechat", "alipay", "bank_card", "store_credit", "manual"]),
        amount: z.number().positive(),
        provider_transaction_id: z.string().trim().min(1).max(200).optional(),
      }),
    )
    .min(1)
    .max(5),
  customer_id: z.string().uuid().optional(),
  points_to_redeem: z.number().int().min(0).max(2147483647).default(0),
  note: z.string().trim().max(500).optional(),
  discount: z
    .object({
      type: z.enum(["amount", "percentage", "final_price"]),
      value: z.number().nonnegative(),
      reason: z.string().trim().min(2).max(200),
    })
    .optional(),
  benefit_snapshot: z.record(z.string(), z.unknown()).optional(),
  authorization_id: z.string().uuid().optional(),
});

export const Route = createFileRoute("/api/public/pos/sales")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      POST: async ({ request }) => {
        let body: z.infer<typeof SaleBody>;
        try {
          body = SaleBody.parse(await request.json());
        } catch (error) {
          return posError(`参数错误：${String(error)}`, 400);
        }
        const invalidTender = body.tenders.find(
          (tender) => tender.provider !== "cash" && !tender.provider_transaction_id,
        );
        if (invalidTender) {
          return posError("非现金支付必须提供渠道交易号", 422, "transaction_id_required");
        }
        const { data: shift, error: shiftError } = await supabaseAdmin
          .from("pos_shifts" as never)
          .select("id,location_id,operator_id,status")
          .eq("id", body.shift_id)
          .maybeSingle();
        if (shiftError) return posError(shiftError.message, 500);
        if (!shift) return posError("收银班次不存在", 404, "shift_not_found");
        const shiftRow = shift as unknown as { location_id: string; operator_id: string };
        const auth = await authenticatePosUser(request, shiftRow.location_id);
        if (!auth.ok) return auth.response;
        if (shiftRow.operator_id !== auth.user.id) {
          return posError("不能使用其他员工的班次", 403, "shift_forbidden");
        }
        const { data, error } = await supabaseAdmin.rpc(
          (body.points_to_redeem > 0 ? "pos_complete_sale_v3" : "pos_complete_sale_v2") as never,
          {
            p_shift_id: body.shift_id,
            p_operator_id: auth.user.id,
            p_client_op_id: body.client_op_id,
            p_items: body.items,
            p_tenders: body.tenders,
            p_customer_id: body.customer_id ?? null,
            ...(body.points_to_redeem > 0 ? { p_points_to_redeem: body.points_to_redeem } : {}),
            p_note: body.note ?? null,
            p_discount_snapshot: body.discount ?? {},
            p_benefit_snapshot: body.benefit_snapshot ?? {},
            p_authorization_id: body.authorization_id ?? null,
          } as never,
        );
        if (error) {
          if (error.message === "sale_operation_cancelled") {
            return posError("原收款操作已安全取消，不能再次提交该操作编号", 409, "sale_operation_cancelled");
          }
          if (body.points_to_redeem > 0 && (error.code === "PGRST202" || error.code === "42883")) {
            return posError("积分抵扣数据库功能尚未启用", 503, "points_rule_not_configured");
          }
          if (/points_|idempotency_conflict/.test(error.message)) {
            return posError(error.message, 409, "points_redemption_conflict");
          }
          const conflict = /stock|quantity|shift|tender|sellable|authorization/i.test(error.message);
          return posError(
            error.message,
            conflict ? 409 : 500,
            conflict ? "sale_conflict" : undefined,
          );
        }
        return posJson({ ok: true, data }, { status: 201 });
      },
    },
  },
});
