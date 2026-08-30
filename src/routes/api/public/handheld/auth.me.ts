import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, err, resolveSessionUser, ok } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/handheld/auth/me")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        const hasSessionCredential = Boolean(
          request.headers.get("authorization") || request.headers.get("x-session-token"),
        );
        if (hasSessionCredential && !session) {
          return err("Invalid session token", 401, { code: "unauthorized" });
        }
        let user = null as null | {
          user_id: string;
          email: string | null;
          display_name: string | null;
          roles: string[];
        };
        if (session) {
          const { data: roleRows } = await supabaseAdmin
            .from("user_roles" as never)
            .select("role")
            .eq("user_id", session.user_id);
          const roles = ((roleRows as { role: string }[] | null) ?? []).map((r) => r.role);
          user = {
            user_id: session.user_id,
            email: session.email,
            display_name: null,
            roles,
          };
        }
        return ok({ device: auth.device, user });
      },
    },
  },
});
