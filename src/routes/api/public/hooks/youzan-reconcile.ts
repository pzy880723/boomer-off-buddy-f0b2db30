import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/youzan-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        if (!apikey || apikey !== process.env.SUPABASE_PUBLISHABLE_KEY) {
          return new Response("unauthorized", { status: 401 });
        }
        const { reconcileAllForCron } = await import("@/lib/youzan-sync.functions");
        const r = await reconcileAllForCron();
        return Response.json(r);
      },
    },
  },
});
