import { createFileRoute } from "@tanstack/react-router";
import { runHandheldReleaseWorker } from "@/server/handheld-release-outbox.server";

// 仅腾讯固定出口环境启用（HANDHELD_RELEASE_WORKER_ENABLED=true）；其他环境返回 503，不调用有赞。
export const Route = createFileRoute("/api/public/hooks/handheld-release-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
        const authorization = request.headers.get("authorization") ?? "";
        if (!serviceRoleKey || authorization !== `Bearer ${serviceRoleKey}`) {
          return Response.json({ ok: false, code: "unauthorized" }, { status: 401 });
        }
        if (process.env.HANDHELD_RELEASE_WORKER_ENABLED !== "true") {
          return Response.json({ ok: false, code: "worker_disabled" }, { status: 503 });
        }
        let limit = 3;
        try {
          const body = (await request.json()) as { limit?: number };
          limit = Math.max(1, Math.min(body.limit ?? 3, 10));
        } catch {
          // Empty body uses the default.
        }
        try {
          return Response.json({ ok: true, data: await runHandheldReleaseWorker(limit) });
        } catch (error) {
          return Response.json(
            { ok: false, code: "worker_failed", message: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          );
        }
      },
    },
  },
});
