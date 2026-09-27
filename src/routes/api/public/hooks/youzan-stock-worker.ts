import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/youzan-stock-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!key || request.headers.get("authorization") !== `Bearer ${key}`) {
          return Response.json({ ok: false, code: "unauthorized" }, { status: 401 });
        }
        // Opt-in on the production server only; never infer this from request headers.
        if (process.env.YOUZAN_STOCK_WORKER_ENABLED !== "true" || process.env.PORT !== "3005") {
          return Response.json({ ok: false, code: "worker_disabled" }, { status: 503 });
        }
        let limit = 1;
        try {
          const body = await request.json();
          if (typeof body?.limit === "number" && Number.isFinite(body.limit)) {
            limit = Math.max(1, Math.min(3, Math.floor(body.limit)));
          }
        } catch { /* Empty body uses a single job. */ }
        try {
          const { runStockSyncWorkerForCron } = await import("@/lib/youzan-sync.functions");
          const data = await runStockSyncWorkerForCron(limit);
          return Response.json({ ok: data.failed === 0, data }, { status: data.failed ? 500 : 200 });
        } catch {
          return Response.json({ ok: false, code: "worker_failed" }, { status: 500 });
        }
      },
    },
  },
});
