// POST /api/public/hooks/youzan-sale-compensation  （service-role Bearer；定时器调用）
// body: { window_hours?: 1..72, limit?: 1..500, dry_run?: boolean, tids?: string[≤20] }
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Body = z.object({
  window_hours: z.number().int().min(1).max(72).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  dry_run: z.boolean().optional(),
  tids: z.array(z.string().regex(/^[A-Za-z0-9_-]{6,64}$/)).min(1).max(20).optional(),
}).strict();

export const Route = createFileRoute("/api/public/hooks/youzan-sale-compensation")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
        if (!key || request.headers.get("authorization") !== `Bearer ${key}`) {
          return Response.json({ ok: false, code: "unauthorized" }, { status: 401 });
        }
        let body: z.infer<typeof Body> = {};
        try {
          const text = await request.text();
          body = Body.parse(text ? JSON.parse(text) : {});
        } catch {
          return Response.json({ ok: false, code: "validation_error" }, { status: 422 });
        }
        if (!body.dry_run && (process.env.YOUZAN_SALE_COMPENSATION_ENABLED ?? "false") !== "true") {
          return Response.json({ ok: false, code: "worker_disabled" }, { status: 503 });
        }
        try {
          const { compensateRecentYouzanSales } = await import("@/lib/youzan-sale-compensation.server");
          const { compensationDeps } = await import("@/lib/youzan-sale-compensation-db.server");
          const data = await compensateRecentYouzanSales(compensationDeps(), {
            windowHours: body.window_hours, limit: body.limit, dryRun: body.dry_run, tids: body.tids,
          });
          return Response.json({ ok: data.failed === 0, data }, { status: data.failed ? 500 : 200 });
        } catch {
          return Response.json({ ok: false, code: "worker_failed" }, { status: 500 });
        }
      },
    },
  },
});
