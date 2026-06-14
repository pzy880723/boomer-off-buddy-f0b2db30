import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/handheld/sku/search")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const url = new URL(request.url);
        const q = (url.searchParams.get("q") || "").trim();
        let query = supabaseAdmin
          .from("inv_skus")
          .select("id, sku_code, name, category, price_tier, stock_qty")
          .order("updated_at", { ascending: false })
          .limit(20);
        if (q) query = query.or(`sku_code.ilike.%${q}%,name.ilike.%${q}%`);
        const { data, error } = await query;
        if (error) return ok({ items: [] });
        return ok({ items: data ?? [] });
      },
    },
  },
});
