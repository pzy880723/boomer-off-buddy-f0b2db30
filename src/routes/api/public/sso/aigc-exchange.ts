import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "node:crypto";
import { emailToPhone } from "@/lib/auth-config";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-ERP-SSO-Secret",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...CORS,
      ...(init.headers || {}),
    },
  });
}
function err(message: string, status = 400, code?: string) {
  return json({ ok: false, error: message, code }, { status });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const Route = createFileRoute("/api/public/sso/aigc-exchange")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        const secret = process.env.ERP_AIGC_SSO_SECRET;
        if (!secret) {
          console.error("[aigc-sso] ERP_AIGC_SSO_SECRET not configured");
          return err("服务未配置", 500, "secret_missing");
        }

        // Accept either X-ERP-SSO-Secret header or Authorization: Bearer <secret>
        const headerSecret = request.headers.get("x-erp-sso-secret") ?? "";
        const authHeader = request.headers.get("authorization") ?? "";
        const bearer = authHeader.startsWith("Bearer ")
          ? authHeader.slice("Bearer ".length).trim()
          : "";
        const provided = headerSecret || bearer;
        if (!provided || !safeEqual(provided, secret)) {
          return err("未授权", 401, "unauthorized");
        }

        let body: { ticket?: string };
        try {
          body = await request.json();
        } catch {
          return err("请求体无效", 400, "invalid_body");
        }
        const ticket = (body.ticket ?? "").trim();
        if (!ticket) return err("缺少 ticket", 400, "ticket_required");

        const tokenHash = createHash("sha256").update(ticket).digest("hex");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Atomic consume: update only if not consumed and not expired
        const nowIso = new Date().toISOString();
        const { data: consumed, error: consumeErr } = await supabaseAdmin
          .from("aigc_sso_tickets" as never)
          .update({ consumed_at: nowIso } as never)
          .eq("token_hash" as never, tokenHash)
          .is("consumed_at" as never, null)
          .gt("expires_at" as never, nowIso)
          .select("id, user_id, expires_at")
          .maybeSingle();

        if (consumeErr) {
          console.error("[aigc-sso] consume failed", consumeErr);
          return err("兑换失败", 500, "consume_failed");
        }
        if (!consumed) {
          // Distinguish: does the ticket exist at all?
          const { data: existing } = await supabaseAdmin
            .from("aigc_sso_tickets" as never)
            .select("consumed_at, expires_at")
            .eq("token_hash" as never, tokenHash)
            .maybeSingle();
          if (!existing) return err("票据无效", 400, "ticket_invalid");
          const row = existing as { consumed_at: string | null; expires_at: string };
          if (row.consumed_at) return err("票据已被使用", 400, "ticket_consumed");
          return err("票据已过期", 400, "ticket_expired");
        }

        const userId = (consumed as { user_id: string }).user_id;

        const { data: userRes, error: userErr } =
          await supabaseAdmin.auth.admin.getUserById(userId);
        if (userErr || !userRes?.user) {
          return err("用户不存在", 404, "user_not_found");
        }
        const u = userRes.user;
        if ((u as { banned_until?: string | null }).banned_until) {
          return err("账号已停用", 403, "user_banned");
        }

        const phone =
          (u.user_metadata?.phone as string | undefined) ??
          u.phone ??
          emailToPhone(u.email ?? null) ??
          null;

        const displayName =
          (u.user_metadata?.display_name as string | undefined) ??
          (u.user_metadata?.name as string | undefined) ??
          (u.user_metadata?.full_name as string | undefined) ??
          null;

        const { data: roleRows } = await supabaseAdmin
          .from("user_roles" as never)
          .select("role")
          .eq("user_id" as never, userId);
        const roles = ((roleRows as { role: string }[] | null) ?? []).map((r) => r.role);

        // Shops the user has access to (kind='shop')
        const { data: permRows } = await supabaseAdmin
          .from("user_location_perms" as never)
          .select("location_id, location:inv_locations!location_id(id, name, kind)")
          .eq("user_id" as never, userId);
        const shops = ((permRows as Array<{
          location: { id: string; name: string; kind: string } | null;
        }> | null) ?? [])
          .map((r) => r.location)
          .filter((l): l is { id: string; name: string; kind: string } => !!l && l.kind === "shop")
          .map((l) => ({ id: l.id, name: l.name }));

        return json({
          ok: true,
          data: {
            user: {
              id: userId,
              phone,
              display_name: displayName,
              roles,
              permissions: ["aigc_access"],
              shops,
            },
          },
        });
      },
    },
  },
});
