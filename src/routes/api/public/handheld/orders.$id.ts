// GET /api/public/handheld/orders/{id} — 父订单只读详情（仅 HQ 角色）
import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { getOrderDetail, isHqUser } from "@/server/handheld-orders.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/api/public/handheld/orders/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return err("Employee session required", 401, { code: "session_required" });
        const isHq = await isHqUser(session.user_id);
        if (!isHq) {
          return err("Headquarters role required", 403, { code: "hq_required" });
        }
        if (!UUID_RE.test(params.id)) return err("Invalid order id", 400);
        try {
          // HQ 具备跨店写授权（capabilities.can_write），门店员工无法到达此路由。
          const order = await getOrderDetail(params.id, { canWrite: isHq });

          if (!order) return err("Order not found", 404);
          return ok(order);
        } catch (error) {
          return err(error instanceof Error ? error.message : String(error), 500);
        }
      },
    },
  },
});
