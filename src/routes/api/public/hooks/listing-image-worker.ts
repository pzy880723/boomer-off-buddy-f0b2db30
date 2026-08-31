import { createFileRoute } from "@tanstack/react-router";
import { runListingImageWorker } from "@/server/handheld-listing-image-jobs.server";

export const Route = createFileRoute("/api/public/hooks/listing-image-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const workerToken = request.headers.get("x-worker-token") ?? "";
        const expected = process.env.LISTING_IMAGE_WORKER_TOKEN ?? "";
        if (!expected || workerToken !== expected) {
          return Response.json({ ok: false, code: "unauthorized" }, { status: 401 });
        }
        let limit = 2;
        try {
          const body = (await request.json()) as { limit?: number };
          limit = Math.max(1, Math.min(body.limit ?? 2, 6));
        } catch {
          // Empty body uses the conservative default.
        }
        try {
          const data = await runListingImageWorker(limit);
          return Response.json({ ok: true, data });
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
