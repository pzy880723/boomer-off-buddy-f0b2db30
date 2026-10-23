import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";
import { attemptResponse, recoverPosPaymentOp } from "@/server/pos-payment.server";

/**
 * 异步收款恢复：创建请求结果丢失/APP 重启后，凭原 client_op_id + shift_id 找回原 attempt；
 * cancel_if_absent=true 仅在原请求从未建单时写永久取消（之后迟到的原请求一律 409 client_op_cancelled）。
 * 已存在的 attempt 绝不在此取消，只回读其状态（未终态请再轮询 GET /payments/{id}）。
 */
const RecoverBody = z.object({
  location_id: z.string().uuid(),
  shift_id: z.string().uuid(),
  client_op_id: z.string().trim().min(8).max(100),
  cancel_if_absent: z.boolean().default(false),
});

export const Route = createFileRoute("/api/public/pos/payments/recover")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      POST: async ({ request }) => {
        const parsed = RecoverBody.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return posError("参数错误", 400, "invalid_request");
        const body = parsed.data;
        const auth = await authenticatePosUser(request, body.location_id);
        if (!auth.ok) return auth.response;
        const r = await recoverPosPaymentOp({
          clientOpId: body.client_op_id, shiftId: body.shift_id, operatorId: auth.user.id,
          locationId: body.location_id, cancelIfAbsent: body.cancel_if_absent,
        });
        if (!r.ok) return posError(r.failure.message, r.failure.status, r.failure.code);
        if (r.state !== "attempt") {
          return posJson({ ok: true, data: { client_op_id: body.client_op_id, state: r.state, payment: null } });
        }
        return posJson({
          ok: true,
          data: { client_op_id: body.client_op_id, state: "attempt", payment: await attemptResponse(r.attempt) },
        });
      },
    },
  },
});
