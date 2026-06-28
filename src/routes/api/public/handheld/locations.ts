import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/handheld/locations")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const { data } = await supabaseAdmin
          .from("inv_locations")
          .select("id, name, kind, is_active")
          .order("kind")
          .order("name");
        return ok({ items: data ?? [] });
      },
    },
  },
});
