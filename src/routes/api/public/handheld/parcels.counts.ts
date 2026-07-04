/**
 * GET /api/public/handheld/parcels/counts
 * 首页 Tab 徽标：pending / received 数量。super_admin 独占。
 */
import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, ok } from "@/server/handheld-auth.server";
import { errCode } from "@/lib/handheld/errors";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSuperAdmin } from "./parcels";

export const Route = createFileRoute("/api/public/handheld/parcels/counts")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const g = await requireSuperAdmin(request);
        if (!g.ok) return g.response;

        const [pendingRes, receivedRes] = await Promise.all([
          supabaseAdmin
            .from("japan_parcels")
            .select("id", { count: "exact", head: true })
            .is("deleted_at", null)
            .in("status", ["purchased", "at_jp_warehouse", "shipping_intl"]),
          supabaseAdmin
            .from("japan_parcels")
            .select("id", { count: "exact", head: true })
            .is("deleted_at", null)
            .in("status", ["delivered", "completed"]),
        ]);
        if (pendingRes.error) return errCode("internal_error", pendingRes.error.message);
        if (receivedRes.error) return errCode("internal_error", receivedRes.error.message);

        return ok({
          pending: pendingRes.count ?? 0,
          received: receivedRes.count ?? 0,
        });
      },
    },
  },
});
