import { createFileRoute } from "@tanstack/react-router";
import { runListingImageWorker } from "@/server/handheld-listing-image-jobs.server";

export const Route = createFileRoute("/api/public/hooks/listing-image-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
        const authorization = request.headers.get("authorization") ?? "";
        if (!serviceRoleKey || authorization !== `Bearer ${serviceRoleKey}`) {
          return Response.json({ ok: false, code: "unauthorized" }, { status: 401 });
        }
        if ((process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED ?? "true") !== "true") {
          return Response.json({ ok: false, code: "worker_disabled" }, { status: 503 });
        }
        let limit = 2;
        try {
          const body = (await request.json()) as { limit?: number };
          if (typeof body.limit === "number" && Number.isFinite(body.limit)) {
            limit = Math.max(1, Math.min(Math.floor(body.limit), 6));
          }
        } catch {
          // Empty body uses the conservative default.
        }
        try {
          const data = await runListingImageWorker(limit);
          if (data.failed) {
            return Response.json({ ok: false, code: "worker_failed", data }, { status: 500 });
          }
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
