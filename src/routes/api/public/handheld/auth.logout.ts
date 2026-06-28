import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { HANDHELD_CORS, authenticateDevice, ok } from "@/server/handheld-auth.server";

export const Route = createFileRoute("/api/public/handheld/auth/logout")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const token =
          request.headers.get("x-session-token") ||
          request.headers.get("X-Session-Token") ||
          "";
        if (token) {
          const sb = createClient(
            process.env.SUPABASE_URL!,
            process.env.SUPABASE_PUBLISHABLE_KEY!,
            {
              auth: { persistSession: false, autoRefreshToken: false },
              global: { headers: { Authorization: `Bearer ${token}` } },
            },
          );
          await sb.auth.signOut();
        }
        return ok({ ok: true });
      },
    },
  },
});
