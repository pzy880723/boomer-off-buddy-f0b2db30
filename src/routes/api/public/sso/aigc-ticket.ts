import { createFileRoute } from "@tanstack/react-router";
import { createHash, randomBytes } from "node:crypto";
import { buildAigcRedirectUrl, hasAigcAccess, isActiveBan } from "@/lib/aigc-sso-contract";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

const TICKET_TTL_SECONDS = 60;

export const Route = createFileRoute("/api/public/sso/aigc-ticket")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        const authHeader = request.headers.get("authorization") ?? "";
        if (!authHeader.startsWith("Bearer ")) {
          return err("未登录", 401, "unauthorized");
        }
        const accessToken = authHeader.slice("Bearer ".length).trim();
        if (!accessToken) return err("未登录", 401, "unauthorized");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(accessToken);
        if (userErr || !userData?.user) {
          return err("登录已失效，请重新登录", 401, "invalid_session");
        }
        const user = userData.user;
        if (isActiveBan((user as { banned_until?: string | null }).banned_until)) {
          return err("账号已停用", 403, "user_banned");
        }

        const { data: roleRows, error: roleErr } = await supabaseAdmin
          .from("user_roles" as never)
          .select("role")
          .eq("user_id" as never, user.id);
        if (roleErr) {
          console.error("[aigc-sso] role lookup failed", roleErr);
          return err("读取账号权限失败", 500, "role_lookup_failed");
        }
        const roles = ((roleRows as { role: string }[] | null) ?? []).map((row) => row.role);
        if (!hasAigcAccess(roles, [])) {
          return err("该账号暂无 AI 营销中心权限", 403, "no_aigc_permission");
        }

        const rawTicket = randomBytes(32).toString("base64url");
        const tokenHash = createHash("sha256").update(rawTicket).digest("hex");
        const expiresAt = new Date(Date.now() + TICKET_TTL_SECONDS * 1000).toISOString();

        const ip =
          request.headers.get("cf-connecting-ip") ||
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          null;
        const ua = request.headers.get("user-agent") || null;

        const { error: insertErr } = await supabaseAdmin.from("aigc_sso_tickets" as never).insert({
          user_id: user.id,
          token_hash: tokenHash,
          expires_at: expiresAt,
          ip,
          user_agent: ua,
        } as never);
        if (insertErr) {
          console.error("[aigc-sso] insert ticket failed", insertErr);
          return err("生成登录票据失败", 500, "ticket_persist_failed");
        }

        const aigcBase = process.env.AIGC_PUBLIC_URL || "https://aigc.boomeroff.com";
        const redirectUrl = buildAigcRedirectUrl(aigcBase, rawTicket);

        return json({
          ok: true,
          data: {
            ticket: rawTicket,
            expires_at: expiresAt,
            expires_in: TICKET_TTL_SECONDS,
            redirect_url: redirectUrl,
          },
        });
      },
    },
  },
});
