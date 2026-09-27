import { createFileRoute } from "@tanstack/react-router";
import { imageRefreshWorkerEnabled, runYouzanImageRefreshWorker } from "@/server/youzan-image-refresh.server";

export const Route = createFileRoute("/api/public/hooks/youzan-image-refresh-worker")({
  server: { handlers: { POST: async ({request}) => {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key || request.headers.get("authorization") !== `Bearer ${key}`)
      return Response.json({ok:false,code:"unauthorized"},{status:401});
    if (!imageRefreshWorkerEnabled()) return Response.json({ok:false,code:"worker_disabled"},{status:503});
    let limit = 2;
    try { const body = await request.json(); if (typeof body.limit === "number") limit=body.limit; } catch { /* default batch */ }
    try {
      const data = await runYouzanImageRefreshWorker(limit);
      return Response.json({ok:data.failed===0,data},{status:data.failed?500:200});
    } catch {
      return Response.json({ok:false,code:"image_worker_failed"},{status:500});
    }
  } } },
});
