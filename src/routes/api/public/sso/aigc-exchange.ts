import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "node:crypto";
import { emailToPhone } from "@/lib/auth-config";
import { hasAigcAccess, isActiveBan, isValidSsoTicket } from "@/lib/aigc-sso-contract";

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
      "Cache-Control": "no-store",
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
        if (!isValidSsoTicket(ticket)) return err("票据无效", 400, "ticket_invalid");

        const tokenHash = createHash("sha256").update(ticket).digest("hex");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const nowIso = new Date().toISOString();
        const { data: ticketRow, error: ticketErr } = await supabaseAdmin
          .from("aigc_sso_tickets" as never)
          .select("id, user_id, consumed_at, expires_at")
          .eq("token_hash" as never, tokenHash)
          .maybeSingle();
        if (ticketErr) {
          console.error("[aigc-sso] ticket lookup failed", ticketErr);
          return err("兑换失败", 500, "ticket_lookup_failed");
        }
        if (!ticketRow) return err("票据无效", 400, "ticket_invalid");
        const pendingTicket = ticketRow as {
          id: string;
          user_id: string;
          consumed_at: string | null;
          expires_at: string;
        };
        if (pendingTicket.consumed_at) return err("票据已被使用", 400, "ticket_consumed");
        if (pendingTicket.expires_at <= nowIso) return err("票据已过期", 400, "ticket_expired");

        const userId = pendingTicket.user_id;

        const { data: userRes, error: userErr } =
          await supabaseAdmin.auth.admin.getUserById(userId);
        if (userErr || !userRes?.user) {
          return err("用户不存在", 404, "user_not_found");
        }
        const u = userRes.user;
        if (isActiveBan((u as { banned_until?: string | null }).banned_until)) {
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

        const { data: roleRows, error: roleErr } = await supabaseAdmin
          .from("user_roles" as never)
          .select("role")
          .eq("user_id" as never, userId);
        if (roleErr) {
          console.error("[aigc-sso] role lookup failed", roleErr);
          return err("读取账号权限失败", 500, "role_lookup_failed");
        }
        const roles = ((roleRows as { role: string }[] | null) ?? []).map((r) => r.role);
        if (!hasAigcAccess(roles, [])) {
          return err("该账号暂无 AI 营销中心权限", 403, "no_aigc_permission");
        }

        let shops: Array<{ id: string; name: string }> = [];
        const isHeadquarters = roles.includes("super_admin") || roles.includes("hq_operator");
        if (isHeadquarters) {
          const { data: allShops, error: shopErr } = await supabaseAdmin
            .from("inv_locations" as never)
            .select("id, name")
            .eq("kind" as never, "shop")
            .eq("is_active" as never, true)
            .order("name" as never, { ascending: true });
          if (shopErr) {
            console.error("[aigc-sso] headquarters shop lookup failed", shopErr);
            return err("读取门店范围失败", 500, "shop_lookup_failed");
          }
          shops = ((allShops as Array<{ id: string; name: string }> | null) ?? []).map((shop) => ({
            id: shop.id,
            name: shop.name,
          }));
        } else {
          const { data: permRows, error: permErr } = await supabaseAdmin
            .from("user_location_perms" as never)
            .select("location_id, location:inv_locations!location_id(id, name, kind)")
            .eq("user_id" as never, userId);
          if (permErr) {
            console.error("[aigc-sso] user shop lookup failed", permErr);
            return err("读取门店范围失败", 500, "shop_lookup_failed");
          }
          shops = (
            (permRows as Array<{
              location: { id: string; name: string; kind: string } | null;
            }> | null) ?? []
          )
            .map((row) => row.location)
            .filter((location): location is { id: string; name: string; kind: string } =>
              Boolean(location && location.kind === "shop"),
            )
            .map((location) => ({ id: location.id, name: location.name }));
        }

        // Consume only after the account, permissions and shop scope have been verified.
        // The conditional update remains atomic, so only one concurrent request can win.
        const { data: consumed, error: consumeErr } = await supabaseAdmin
          .from("aigc_sso_tickets" as never)
          .update({ consumed_at: nowIso } as never)
          .eq("id" as never, pendingTicket.id)
          .is("consumed_at" as never, null)
          .gt("expires_at" as never, nowIso)
          .select("id")
          .maybeSingle();
        if (consumeErr) {
          console.error("[aigc-sso] consume failed", consumeErr);
          return err("兑换失败", 500, "consume_failed");
        }
        if (!consumed) {
          const { data: latest } = await supabaseAdmin
            .from("aigc_sso_tickets" as never)
            .select("consumed_at, expires_at")
            .eq("id" as never, pendingTicket.id)
            .maybeSingle();
          const latestTicket = latest as { consumed_at: string | null; expires_at: string } | null;
          if (latestTicket?.consumed_at) return err("票据已被使用", 400, "ticket_consumed");
          return err("票据已过期", 400, "ticket_expired");
        }

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
