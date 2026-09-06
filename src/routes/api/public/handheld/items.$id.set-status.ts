// POST /api/public/handheld/items/{id}/set-status
// Body: { is_display: boolean }
// 权限：super_admin | hq_operator | shop_manager
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  loadUserRoles,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { errCode } from "@/lib/handheld/errors";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { deriveListingStatus, statusLabel } from "@/lib/handheld/listing-status";

const Body = z.object({ is_display: z.boolean() });

const ALLOWED_ROLES = new Set(["super_admin", "hq_operator", "shop_manager"]);

export const Route = createFileRoute("/api/public/handheld/items/$id/set-status")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        const session = await resolveSessionUser(request);
        if (!session) return err("Unauthorized", 401);
        const roles = await loadUserRoles(session.user_id);
        if (!roles.some((r) => ALLOWED_ROLES.has(r))) {
          return err("Role not permitted", 403, { code: "role_forbidden" });
        }

        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch (e) {
          return errCode("invalid_body", undefined, { detail: String(e) });
        }

        const { data: updated, error: updErr } = await supabaseAdmin
          .from("inv_skus")
          .update({ is_display: body.is_display, updated_at: new Date().toISOString() } as never)
          .eq("id", params.id)
          .select("id, is_display, stock_qty")
          .maybeSingle();
        if (updErr) return err(updErr.message, 500);
        if (!updated) return errCode("not_found", "SKU not found");

        // Sum current total across all locations
        const { data: stocks } = await supabaseAdmin
          .from("inv_stocks")
          .select("qty")
          .eq("sku_id", params.id);
        const totalQty = (stocks ?? []).reduce(
          (sum, r) => sum + (Number((r as { qty: number }).qty) || 0),
          0,
        );

        // Enqueue youzan is_display push for each linked shop
        const { data: links } = await supabaseAdmin
          .from("sku_youzan_links")
          .select("shop_id")
          .eq("sku_id", params.id);
        if (links && links.length > 0) {
          for (const l of links as Array<{ shop_id: string }>) {
            await supabaseAdmin.from("youzan_stock_sync_queue").upsert(
              {
                sku_id: params.id,
                shop_id: l.shop_id,
                action: "push_is_display",
                target_is_display: body.is_display,
                target_stock: totalQty,
                reason: "handheld_set_status",
                status: "pending",
                next_run_at: new Date().toISOString(),
                last_error: null,
              } as never,
              { onConflict: "sku_id,shop_id" },
            );
          }
        }

        const ls = deriveListingStatus(body.is_display, totalQty);
        return ok({
          id: params.id,
          is_display: body.is_display,
          listing_status: ls,
          status_label: statusLabel(ls),
          total_stock_qty: totalQty,
        });
      },
    },
  },
});
