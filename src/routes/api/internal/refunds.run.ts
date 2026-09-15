import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import { createRefundWorkerDeps } from "@/server/shortage-refund-runtime.server";
import { runRefundIntents, WORKER_DISABLED_CODE } from "@/server/refund-intent-worker.server";

/**
 * 缺货退款执行 worker 的内部入口（systemd/cron 调用，非公开）。
 * 生产执行默认关闭：未开启时返回 503 + refund_worker_disabled，绝不假装成功。
 */
export const Route = createFileRoute("/api/internal/refunds/run")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["SHORTAGE_REFUND_WORKER_TOKEN"]?.trim();
        const supplied = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
        if (!expected || expected.length < 32) {
          return Response.json({ ok: false, error: "Refund worker not configured" }, { status: 503 });
        }
        const left = Buffer.from(expected);
        const right = Buffer.from(supplied);
        if (left.length !== right.length || !timingSafeEqual(left, right)) {
          return new Response(null, { status: 401 });
        }
        try {
          const result = await runRefundIntents(createRefundWorkerDeps(), 5);
          const status = result.code === WORKER_DISABLED_CODE ? 503 : result.ok ? 200 : 503;
          return Response.json(result, { status });
        } catch {
          return Response.json({ ok: false, error: "Refund worker unavailable" }, { status: 503 });
        }
      },
    },
  },
});
