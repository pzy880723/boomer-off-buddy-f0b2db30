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
          if (body.action === "enqueue") {
            const data = await enqueueOrderSyncWindows({
              days: body.days,
              shop_id: body.shop_id,
              windowHours: body.window_hours,
            });
            return Response.json({ ok: true, action: "enqueue", data });
          }
          if (body.action === "progress") {
            return Response.json({ ok: true, action: "progress", data: await orderSyncProgress() });
          }

          const slices = Math.max(1, Math.min(body.slices ?? 1, 3));
          const workerId = `hook-${crypto.randomUUID()}`;
          const results: Record<string, unknown>[] = [];
          for (let i = 0; i < slices; i += 1) {
            const r = await runOrderSyncSliceOnce({ workerId, maxPages: body.max_pages });
            results.push(r);
            if (r["claimed"] === false) break;
          }
          return Response.json({
            ok: true,
            action: "run",
            data: { results, progress: await orderSyncProgress() },
          });
        } catch (error) {
          return Response.json(
            {
              ok: false,
              code: "worker_failed",
              message: error instanceof Error ? error.message : String(error),
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
