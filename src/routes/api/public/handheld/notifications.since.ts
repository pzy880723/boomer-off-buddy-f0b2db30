import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { NotificationsSinceQuery } from "@/lib/handheld/schemas";

export const Route = createFileRoute("/api/public/handheld/notifications/since")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        const url = new URL(request.url);
        let q: ReturnType<typeof NotificationsSinceQuery.parse>;
        try {
          q = NotificationsSinceQuery.parse({
            ts: url.searchParams.get("ts") ?? undefined,
            limit: url.searchParams.get("limit") ?? undefined,
          });
        } catch (e) {
          return err("Invalid query", 400, { code: "validation_error", detail: String(e) });
        }

        let qb = supabaseAdmin
          .from("inv_handheld_notifications" as never)
          .select("id, kind, title, payload, ts, device_id, location_id")
          .order("ts", { ascending: true })
          .limit(q.limit);
        if (q.ts) qb = qb.gt("ts", q.ts);

        const { data, error } = await qb;
        if (error) return err(`query failed: ${error.message}`, 500);

        // 过滤：只下发给本设备 / 本库位 / 全局（device_id+location_id 都为 null）
        const items = ((data as any[]) ?? []).filter((r) => {
          if (r.device_id && r.device_id !== auth.device.id) return false;
          if (r.location_id && r.location_id !== auth.device.location_id) return false;
          return true;
        });

        const lastTs = items.length > 0 ? items[items.length - 1].ts : q.ts ?? new Date().toISOString();

        return ok({
          items: items.map((r) => ({
            id: r.id,
            kind: r.kind,
            title: r.title ?? null,
            payload: r.payload ?? {},
            ts: r.ts,
          })),
          server_ts: lastTs,
        });
      },
    },
  },
});
