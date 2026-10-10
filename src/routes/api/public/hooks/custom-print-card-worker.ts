import { createFileRoute } from "@tanstack/react-router";
import { processCustomCardJobs } from "@/server/custom-print-cards.server";
import { customCardDeps } from "@/server/custom-print-cards-db.server";

export const Route = createFileRoute("/api/public/hooks/custom-print-card-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
        if (!key || request.headers.get("authorization") !== `Bearer ${key}`) {
          return Response.json({ ok: false, code: "unauthorized" }, { status: 401 });
        }
        if (process.env.CUSTOM_PRINT_CARD_JOBS_ENABLED !== "true") {
          return Response.json({ ok: false, code: "worker_disabled" }, { status: 503 });
        }
        try {
          // Independent queue: never extend the existing listing-image request deadline.
          const data = await processCustomCardJobs(customCardDeps(), 1);
          return Response.json({ ok: true, data });
        } catch {
          return Response.json({ ok: false, code: "worker_failed" }, { status: 500 });
        }
      },
    },
  },
});
