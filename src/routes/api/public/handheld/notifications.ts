import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/handheld/notifications")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const url = new URL(request.url);
        const locationId = url.searchParams.get("location_id") || auth.device.location_id;
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

        const { data, error } = await supabaseAdmin
          .from("inv_handheld_notifications" as never)
          .select("id, kind, title, payload, ts, device_id, location_id")
          .order("ts", { ascending: false })
          .limit(limit);
        if (error) return err(error.message, 500);

        const items = ((data as any[]) ?? []).filter((r) => {
          if (r.device_id && r.device_id !== auth.device.id) return false;
          if (r.location_id && locationId && r.location_id !== locationId) return false;
          return true;
        });

        return ok({
          items: items.map((r) => ({
            id: r.id,
            kind: r.kind,
            title: r.title ?? null,
            payload: r.payload ?? {},
            ts: r.ts,
          })),
        });
      },
    },
  },
});
