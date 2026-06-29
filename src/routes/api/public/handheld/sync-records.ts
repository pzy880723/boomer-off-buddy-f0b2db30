import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/handheld/sync-records")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const url = new URL(request.url);
        const status = url.searchParams.get("status"); // pending | done | failed
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

        let qb = supabaseAdmin
          .from("youzan_stock_sync_queue")
          .select("id, sku_id, target_stock, reason, status, attempts, last_error, created_at, updated_at")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (status) qb = qb.eq("status", status);

        const { data, error } = await qb;
        if (error) return err(error.message, 500);
        return ok({ items: data ?? [] });
      },
    },
  },
});
