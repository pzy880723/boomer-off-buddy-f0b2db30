import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/handheld/stocktakes")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const url = new URL(request.url);
        const locationId = url.searchParams.get("location_id") || auth.device.location_id;
        if (!locationId) return err("Missing location_id", 400, { code: "no_location" });
        const status = url.searchParams.get("status");

        let qb = supabaseAdmin
          .from("stocktakes")
          .select("id, code, status, opened_at, submitted_at, reviewed_at, notes")
          .eq("location_id", locationId)
          .order("opened_at", { ascending: false })
          .limit(50);
        if (status) qb = qb.eq("status", status);

        const { data, error } = await qb;
        if (error) return err(error.message, 500);
        return ok({ items: data ?? [] });
      },
    },
  },
});
