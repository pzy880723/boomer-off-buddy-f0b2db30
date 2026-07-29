import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  loadUserRoles,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

function isHq(roles: string[]) {
  return roles.includes("super_admin") || roles.includes("hq_operator");
}

export const Route = createFileRoute("/api/public/handheld/label-templates/$id/set-default")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const user = await resolveSessionUser(request);
        if (!user) return err("Missing session token", 401, { code: "unauthorized" });
        const roles = await loadUserRoles(user.user_id);
        if (!isHq(roles)) return err("HQ role required", 403, { code: "forbidden" });

        const { data: cur } = await (supabaseAdmin.from("inv_label_templates" as never) as any)
          .select("id, print_type")
          .eq("id", params.id)
          .maybeSingle();
        if (!cur) return err("Not found", 404, { code: "not_found" });

        await (supabaseAdmin.from("inv_label_templates" as never) as any)
          .update({ is_default: false })
          .eq("is_default", true)
          .eq("print_type", (cur as any).print_type ?? "label");
        const { error } = await (supabaseAdmin.from("inv_label_templates" as never) as any)
          .update({ is_default: true, updated_by: user.user_id })
          .eq("id", params.id);
        if (error) return err(error.message, 500);
        return ok({ default_template_id: params.id });
      },
    },
  },
});
