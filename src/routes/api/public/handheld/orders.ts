// GET /api/public/handheld/orders — 父订单只读列表（仅 HQ 角色）
import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  userCanAccessLocation,
  ok,
  err,
} from "@/server/handheld-auth.server";
import {
  ORDER_STATUS_FILTERS,
  clampPage,
  clampPageSize,
  isHqUser,
  listOrders,
  type OrderStatusFilter,
} from "@/server/handheld-orders.server";

export const Route = createFileRoute("/api/public/handheld/orders")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return err("Employee session required", 401, { code: "session_required" });
        if (!(await isHqUser(session.user_id))) {
          return err("Headquarters role required", 403, { code: "hq_required" });
        }

        const url = new URL(request.url);
        const statusRaw = (url.searchParams.get("status") ?? "all") as OrderStatusFilter;
        if (!ORDER_STATUS_FILTERS.includes(statusRaw)) {
          return err("Invalid status filter", 400, { code: "invalid_status" });
        }
        const page = clampPage(url.searchParams.get("page"));
        const pageSize = clampPageSize(url.searchParams.get("page_size"));
        const q = (url.searchParams.get("q") ?? "").trim() || null;
        const locationId = url.searchParams.get("location_id");
        if (locationId && !(await userCanAccessLocation(session.user_id, locationId))) {
          return err("You do not have permission to operate this location", 403, {
            code: "location_forbidden",
          });
        }

        try {
          const result = await listOrders({
            q,
            status: statusRaw,
            page,
            pageSize,
            locationId: locationId || null,
          });
          return ok({
            items: result.items,
            total: result.total,
            page,
            page_size: pageSize,
          });
        } catch (error) {
          return err(error instanceof Error ? error.message : String(error), 500);
        }
      },
    },
  },
});
