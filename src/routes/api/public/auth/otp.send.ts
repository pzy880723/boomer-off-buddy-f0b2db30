import { createFileRoute } from "@tanstack/react-router";
import { createHash } from "node:crypto";
import { PHONE_REGEX } from "@/lib/auth-config";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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
function ok<T>(data: T) {
  return json({ ok: true, data });
}
function err(message: string, status = 400, extra?: Record<string, unknown>) {
  return json({ ok: false, error: message, ...(extra || {}) }, { status });
}

function genCode() {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const n = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
  return String(n % 1_000_000).padStart(6, "0");
}

function hashCode(phone: string, code: string) {
  return createHash("sha256").update(`${phone}:${code}`).digest("hex");
}

export const Route = createFileRoute("/api/public/auth/otp/send")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        let body: { phone?: string; purpose?: string };
        try {
          body = await request.json();
        } catch {
          return err("Invalid body", 400, { code: "invalid_body" });
        }
        const phone = (body.phone ?? "").trim();
        const purpose = body.purpose ?? "login";
        if (!PHONE_REGEX.test(phone)) {
          return err("手机号格式不正确", 400, { code: "invalid_phone" });
        }

        const ip =
          request.headers.get("cf-connecting-ip") ||
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          null;
        const ua = request.headers.get("user-agent") ?? null;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // 速率限制
        const now = Date.now();
        const since60s = new Date(now - 60_000).toISOString();
        const since10m = new Date(now - 10 * 60_000).toISOString();
        const since1h = new Date(now - 60 * 60_000).toISOString();

        const { count: recent } = await supabaseAdmin
          .from("auth_phone_otp" as never)
          .select("id", { count: "exact", head: true })
          .eq("phone" as never, phone)
          .gte("created_at" as never, since60s);
        if ((recent ?? 0) > 0) {
          return err("发送过于频繁，请 60 秒后重试", 429, { code: "rate_limited" });
        }
        const { count: in10m } = await supabaseAdmin
          .from("auth_phone_otp" as never)
          .select("id", { count: "exact", head: true })
          .eq("phone" as never, phone)
          .gte("created_at" as never, since10m);
        if ((in10m ?? 0) >= 5) {
          return err("该手机号 10 分钟内发送已达上限", 429, { code: "rate_limited" });
        }
        if (ip) {
          const { count: ipCnt } = await supabaseAdmin
            .from("auth_phone_otp" as never)
            .select("id", { count: "exact", head: true })
            .eq("ip" as never, ip)
            .gte("created_at" as never, since1h);
          if ((ipCnt ?? 0) >= 20) {
            return err("当前网络请求过多，请稍后再试", 429, { code: "rate_limited" });
          }
        }

        const code = genCode();
        const code_hash = hashCode(phone, code);
        const expires_at = new Date(now + 5 * 60_000).toISOString();

        const { error: insErr } = await supabaseAdmin
          .from("auth_phone_otp" as never)
          .insert({
            phone,
            code_hash,
            purpose,
            expires_at,
            ip,
            user_agent: ua,
          } as never);
        if (insErr) return err(`Insert failed: ${insErr.message}`, 500);

        // 发送短信
        const { sendOtpSms } = await import("@/server/sms.tencent.server");
        const sendRes = await sendOtpSms(`+86${phone}`, code, 5);
        if (!sendRes.ok) {
          return err(sendRes.message || "短信发送失败", 502, {
            code: "sms_send_failed",
            detail: sendRes.code,
          });
        }
        return ok({ ttl: 300 });
      },
    },
  },
});
