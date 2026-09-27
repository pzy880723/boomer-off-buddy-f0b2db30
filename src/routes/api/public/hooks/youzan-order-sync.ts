import { createFileRoute } from "@tanstack/react-router";
import {
  enqueueOrderSyncWindows,
  orderSyncProgress,
  runOrderSyncSliceOnce,
} from "@/server/youzan-order-sync.server";

type Body = {
  action?: "enqueue" | "run" | "progress";
  days?: number;
  shop_id?: string;
  window_hours?: number;
  max_pages?: number;
  slices?: number;
};

export const Route = createFileRoute("/api/public/hooks/youzan-order-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
        const authorization = request.headers.get("authorization") ?? "";
        if (!serviceRoleKey || authorization !== `Bearer ${serviceRoleKey}`) {
          return Response.json({ ok: false, code: "unauthorized" }, { status: 401 });
        }

        let body: Body = {};
        try {
          body = ((await request.json()) as Body) ?? {};
        } catch {
          body = {};
        }

        try {
          if (body.action === "progress") {
            return Response.json({ ok: true, action: "progress", data: await orderSyncProgress() });
          }
          if ((process.env.YOUZAN_ORDER_SYNC_WORKER_ENABLED ?? "true") !== "true" ||
              (process.env.ERP_PORT !== undefined && process.env.ERP_PORT !== "3005")) {
            return Response.json({ ok: false, code: "worker_disabled" }, { status: 503 });
          }
          if (body.action === "enqueue") {
            const data = await enqueueOrderSyncWindows({
              days: body.days,
              shop_id: body.shop_id,
              windowHours: body.window_hours,
            });
            return Response.json({ ok: true, action: "enqueue", data });
          }
          const slices = typeof body.slices === "number" && Number.isFinite(body.slices)
            ? Math.max(1, Math.min(Math.floor(body.slices), 3)) : 1;
          const workerId = `hook-${crypto.randomUUID()}`;
          const results: Record<string, unknown>[] = [];
          let failed = false;
          for (let i = 0; i < slices; i += 1) {
            const r = await runOrderSyncSliceOnce({ workerId, maxPages: body.max_pages });
            results.push(r);
            const idle = r.claimed === false && r.reason === "idle" && r.status == null && r.applied == null;
            failed = r.error != null || r.applied === false || (!idle &&
              (r.claimed !== true || r.applied !== true || !["pending", "done"].includes(String(r.status))));
            if (failed) break;
            if (r["claimed"] === false) break;
          }
          return Response.json({
            ok: !failed,
            action: "run",
            data: { results, progress: await orderSyncProgress() },
          }, { status: failed ? 207 : 200 });
        } catch {
          return Response.json(
            {
              ok: false,
              code: "worker_failed",
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
