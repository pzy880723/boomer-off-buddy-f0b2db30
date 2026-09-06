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

async function listTemplates(printType?: "label" | "receipt") {
  let query = (supabaseAdmin.from("inv_label_templates" as never) as any)
    .select("id, name, print_type, width_mm, height_mm, elements, is_default, version, updated_at")
    .order("is_default", { ascending: false })
    .order("updated_at", { ascending: false });
  if (printType) query = query.eq("print_type", printType);
  const { data, error } = await query;
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
        const url = new URL(request.url);
        const rawType = url.searchParams.get("print_type");
        const printType =
          rawType === "label" || rawType === "receipt"
            ? (rawType as "label" | "receipt")
            : undefined;
        try {
          const items = await listTemplates(printType);
          const labelDefault = items.find(
            (item) => item.is_default && (item.print_type ?? "label") === "label",
          );
          const receiptDefault = items.find(
            (item) => item.is_default && item.print_type === "receipt",
          );
          return ok({
            default_template_id: labelDefault?.id ?? null,
            default_template_ids: {
              label: labelDefault?.id ?? null,
              receipt: receiptDefault?.id ?? null,
            },
            items: items.map((r) => ({
              id: r.id,
              name: r.name,
              print_type: r.print_type ?? "label",
              width_mm: r.print_type === "receipt" ? 58 : Number(r.width_mm),
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
        const print_type = body?.print_type === "receipt" ? "receipt" : "label";
        const width_mm = print_type === "receipt" ? 58 : Number(body?.width_mm ?? 53);
        const height_mm = Number(body?.height_mm ?? 35);
        const elements = Array.isArray(body?.elements) ? body.elements : [];
        const setDefault = body?.is_default === true;

        if (setDefault) {
          await (supabaseAdmin.from("inv_label_templates" as never) as any)
            .update({ is_default: false })
            .eq("is_default", true)
            .eq("print_type", print_type);
        }

        const { data, error } = await (supabaseAdmin.from("inv_label_templates" as never) as any)
          .insert({
            name,
            print_type,
            width_mm,
            height_mm,
            elements,
            is_default: setDefault,
            created_by: user.user_id,
            updated_by: user.user_id,
          })
          .select(
            "id, name, print_type, width_mm, height_mm, elements, is_default, version, updated_at",
          )
          .single();
        if (error) return err(error.message, 500);
        return ok(data);
      },
    },
  },
});
