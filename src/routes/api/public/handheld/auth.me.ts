import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  err,
  resolveSessionUser,
  ok,
} from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadStaffProfile } from "@/server/staff-profile.server";

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
          avatar_url: string | null;
          roles: string[];
        };
        if (session) {
          const { data: roleRows, error: roleError } = await supabaseAdmin
            .from("user_roles" as never)
            .select("role")
            .eq("user_id", session.user_id);
          if (roleError) return err("账号资料暂不可用，请重试", 503);
          const roles = ((roleRows as { role: string }[] | null) ?? []).map((r) => r.role);
          let profile;
          try { profile = await loadStaffProfile(session.user_id); }
          catch { return err("账号资料暂不可用，请重试", 503); }
          if (!profile) return err("Invalid session token", 401, { code: "unauthorized" });
          user = {
            user_id: session.user_id,
            email: session.email,
            display_name: profile?.display_name ?? null,
            avatar_url: profile?.avatar_url ?? null,
            roles,
          };
        }
        return ok({ device: auth.device, user });
      },
    },
  },
});
