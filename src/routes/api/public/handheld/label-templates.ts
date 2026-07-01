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

async function listTemplates() {
  const { data, error } = await supabaseAdmin
    .from("inv_label_templates" as never)
    .select("id, name, width_mm, height_mm, elements, is_default, version, updated_at")
    .order("is_default", { ascending: false })
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as any[]) ?? [];
}

export const Route = createFileRoute("/api/public/handheld/label-templates")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),

      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const user = await resolveSessionUser(request);
        const roles = user ? await loadUserRoles(user.user_id) : [];
        try {
          const items = await listTemplates();
          const def = items.find((r) => r.is_default);
          return ok({
            default_template_id: def?.id ?? null,
            items: items.map((r) => ({
              id: r.id,
              name: r.name,
              width_mm: Number(r.width_mm),
              height_mm: Number(r.height_mm),
              is_default: !!r.is_default,
              elements: r.elements ?? [],
              version: r.version ?? 1,
              updated_at: r.updated_at,
            })),
            can_manage: isHq(roles),
          });
        } catch (e: any) {
          return err(e.message ?? "Load failed", 500);
        }
      },

      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const user = await resolveSessionUser(request);
        if (!user) return err("Missing session token", 401, { code: "unauthorized" });
        const roles = await loadUserRoles(user.user_id);
        if (!isHq(roles)) return err("HQ role required", 403, { code: "forbidden" });

        let body: any;
        try {
          body = await request.json();
        } catch {
          return err("Invalid JSON", 400, { code: "invalid_body" });
        }
        const name = String(body?.name ?? "").trim();
        if (!name) return err("name required", 422, { code: "validation_error" });
        const width_mm = Number(body?.width_mm ?? 53);
        const height_mm = Number(body?.height_mm ?? 35);
        const elements = Array.isArray(body?.elements) ? body.elements : [];
        const setDefault = body?.is_default === true;

        if (setDefault) {
          await supabaseAdmin
            .from("inv_label_templates" as never)
            .update({ is_default: false })
            .eq("is_default", true);
        }

        const { data, error } = await supabaseAdmin
          .from("inv_label_templates" as never)
          .insert({
            name,
            width_mm,
            height_mm,
            elements,
            is_default: setDefault,
            created_by: user.user_id,
            updated_by: user.user_id,
          })
          .select("id, name, width_mm, height_mm, elements, is_default, version, updated_at")
          .single();
        if (error) return err(error.message, 500);
        return ok(data);
      },
    },
  },
});
