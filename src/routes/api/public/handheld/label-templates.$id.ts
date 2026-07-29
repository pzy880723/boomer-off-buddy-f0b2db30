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

async function requireHq(request: Request) {
  const auth = await authenticateDevice(request);
  if (!auth.ok) return { ok: false as const, response: auth.response };
  const user = await resolveSessionUser(request);
  if (!user)
    return {
      ok: false as const,
      response: err("Missing session token", 401, { code: "unauthorized" }),
    };
  const roles = await loadUserRoles(user.user_id);
  if (!isHq(roles))
    return {
      ok: false as const,
      response: err("HQ role required", 403, { code: "forbidden" }),
    };
  return { ok: true as const, user };
}

export const Route = createFileRoute("/api/public/handheld/label-templates/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),

      PUT: async ({ request, params }) => {
        const g = await requireHq(request);
        if (!g.ok) return g.response;

        let body: any;
        try {
          body = await request.json();
        } catch {
          return err("Invalid JSON", 400, { code: "invalid_body" });
        }
        const patch: Record<string, unknown> = { updated_by: g.user.user_id };
        if (typeof body?.name === "string") patch.name = body.name.trim();
        if (body?.print_type === "label" || body?.print_type === "receipt") {
          patch.print_type = body.print_type;
        }
        if (body?.width_mm != null) {
          patch.width_mm = body?.print_type === "receipt" ? 58 : Number(body.width_mm);
        }
        if (body?.height_mm != null) patch.height_mm = Number(body.height_mm);
        if (Array.isArray(body?.elements)) patch.elements = body.elements;
        // version bump
        const { data: cur } = await (supabaseAdmin.from("inv_label_templates" as never) as any)
          .select("version, is_default, print_type")
          .eq("id", params.id)
          .maybeSingle();
        if (!cur) return err("Not found", 404, { code: "not_found" });
        patch.version = ((cur as any).version ?? 1) + 1;
        const printType =
          body?.print_type === "receipt"
            ? "receipt"
            : body?.print_type === "label"
              ? "label"
              : ((cur as any).print_type ?? "label");
        if (printType === "receipt") patch.width_mm = 58;

        if (body?.is_default === true && !(cur as any).is_default) {
          await (supabaseAdmin.from("inv_label_templates" as never) as any)
            .update({ is_default: false })
            .eq("is_default", true)
            .eq("print_type", printType);
          patch.is_default = true;
        }

        const { data, error } = await (supabaseAdmin.from("inv_label_templates" as never) as any)
          .update(patch)
          .eq("id", params.id)
          .select(
            "id, name, print_type, width_mm, height_mm, elements, is_default, version, updated_at",
          )
          .single();
        if (error) return err(error.message, 500);
        return ok(data);
      },

      DELETE: async ({ request, params }) => {
        const g = await requireHq(request);
        if (!g.ok) return g.response;

        const { data: cur } = await (supabaseAdmin.from("inv_label_templates" as never) as any)
          .select("id, is_default, print_type")
          .eq("id", params.id)
          .maybeSingle();
        if (!cur) return err("Not found", 404, { code: "not_found" });

        const { error } = await (supabaseAdmin.from("inv_label_templates" as never) as any)
          .delete()
          .eq("id", params.id);
        if (error) return err(error.message, 500);

        // If deleted default, promote the most-recently-updated remaining template.
        if ((cur as any).is_default) {
          const { data: next } = await (supabaseAdmin.from("inv_label_templates" as never) as any)
            .select("id")
            .eq("print_type", (cur as any).print_type ?? "label")
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (next) {
            await (supabaseAdmin.from("inv_label_templates" as never) as any)
              .update({ is_default: true })
              .eq("id", (next as any).id);
          }
        }
        return ok({ deleted: true });
      },
    },
  },
});
