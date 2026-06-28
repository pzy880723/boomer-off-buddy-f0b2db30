import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { LoginReq } from "@/lib/handheld/schemas";

export const Route = createFileRoute("/api/public/handheld/auth/login")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        let body: { email: string; password: string };
        try {
          body = LoginReq.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { detail: String(e) });
        }

        const sb = createClient(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_PUBLISHABLE_KEY!,
          { auth: { persistSession: false, autoRefreshToken: false } },
        );
        const { data, error } = await sb.auth.signInWithPassword({
          email: body.email,
          password: body.password,
        });
        if (error || !data.session || !data.user) {
          return err(error?.message || "Invalid credentials", 401);
        }

        const { data: roleRows } = await supabaseAdmin
          .from("user_roles" as never)
          .select("role")
          .eq("user_id", data.user.id);
        const roles = ((roleRows as { role: string }[] | null) ?? []).map((r) => r.role);

        const { data: locs } = await supabaseAdmin
          .from("inv_locations")
          .select("id, name, kind, is_active")
          .eq("is_active", true)
          .order("kind")
          .order("name");

        return ok({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at ?? 0,
          user: {
            user_id: data.user.id,
            email: data.user.email ?? null,
            display_name:
              (data.user.user_metadata?.display_name as string | undefined) ??
              (data.user.user_metadata?.full_name as string | undefined) ??
              null,
            roles,
          },
          locations: locs ?? [],
        });
      },
    },
  },
});
