import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/youzan-stock-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // 简单口令：用 anon apikey 验
        const apikey = request.headers.get("apikey");
        if (!apikey || apikey !== process.env.SUPABASE_PUBLISHABLE_KEY) {
          return new Response("unauthorized", { status: 401 });
        }
        const { runStockSyncWorkerForCron } = await import(
          "@/lib/youzan-sync.functions"
        );
        const r = await runStockSyncWorkerForCron();
        return Response.json(r);
      },
    },
  },
});
