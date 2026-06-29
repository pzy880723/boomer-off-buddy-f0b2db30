import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { PHONE_REGEX, phoneToEmail } from "@/lib/auth-config";

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

function hashCode(phone: string, code: string) {
  return createHash("sha256").update(`${phone}:${code}`).digest("hex");
}

function genDeviceCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `HH-${s}`;
}
function genDeviceToken() {
  const bytes = new Uint8Array(30);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

type BootstrapExtras = {
  install_id?: string;
  device_label?: string;
  capabilities?: Record<string, unknown>;
  app_version?: string;
  os_version?: string;
};

export const Route = createFileRoute("/api/public/auth/otp/verify")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        let body: { phone?: string; code?: string } & BootstrapExtras;
        try {
          body = await request.json();
        } catch {
          return err("Invalid body", 400, { code: "invalid_body" });
        }
        const phone = (body.phone ?? "").trim();
        const code = (body.code ?? "").trim();
        if (!PHONE_REGEX.test(phone)) {
          return err("手机号格式不正确", 400, { code: "invalid_phone" });
        }
        if (!/^\d{6}$/.test(code)) {
          return err("验证码格式不正确", 400, { code: "otp_invalid" });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // 取最新未消费记录
        const { data: rec } = await supabaseAdmin
          .from("auth_phone_otp" as never)
          .select("id, code_hash, expires_at, consumed_at, attempts")
          .eq("phone" as never, phone)
          .is("consumed_at" as never, null)
          .order("created_at" as never, { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!rec) {
          return err("请先获取验证码", 400, { code: "otp_not_found" });
        }
        const r = rec as {
          id: string;
          code_hash: string;
          expires_at: string;
          consumed_at: string | null;
          attempts: number;
        };
        if (new Date(r.expires_at).getTime() < Date.now()) {
          return err("验证码已过期，请重新获取", 400, { code: "otp_expired" });
        }
        if (r.attempts >= 5) {
          return err("尝试次数过多，请重新获取验证码", 429, { code: "otp_locked" });
        }
        if (r.code_hash !== hashCode(phone, code)) {
          await supabaseAdmin
            .from("auth_phone_otp" as never)
            .update({ attempts: r.attempts + 1 } as never)
            .eq("id", r.id);
          return err("验证码错误", 400, { code: "otp_invalid" });
        }

        // 标记 consumed
        await supabaseAdmin
          .from("auth_phone_otp" as never)
          .update({ consumed_at: new Date().toISOString() } as never)
          .eq("id", r.id);

        // 找 ERP 用户
        const email = phoneToEmail(phone);
        const { data: list, error: listErr } = await supabaseAdmin.auth.admin.listUsers({
          page: 1,
          perPage: 200,
        });
        if (listErr) return err(listErr.message, 500);
        const user = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
        if (!user) {
          return err("该手机号未注册，请联系管理员", 404, { code: "user_not_found" });
        }

        // 用 magiclink 换 session
        const { data: linkData, error: linkErr } =
          await supabaseAdmin.auth.admin.generateLink({
            type: "magiclink",
            email,
          });
        if (linkErr || !linkData?.properties?.hashed_token) {
          return err(linkErr?.message || "生成登录令牌失败", 500);
        }
        const tokenHash = linkData.properties.hashed_token;

        const sb = createClient(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_PUBLISHABLE_KEY!,
          { auth: { persistSession: false, autoRefreshToken: false } },
        );
        const { data: verifyData, error: verifyErr } = await sb.auth.verifyOtp({
          type: "magiclink",
          token_hash: tokenHash,
        });
        if (verifyErr || !verifyData.session || !verifyData.user) {
          return err(verifyErr?.message || "登录令牌验证失败", 500);
        }
        const session = verifyData.session;
        const authedUser = verifyData.user;

        // 通用用户/角色信息
        const { data: roleRows } = await supabaseAdmin
          .from("user_roles" as never)
          .select("role")
          .eq("user_id", authedUser.id);
        const roles = ((roleRows as { role: string }[] | null) ?? []).map((x) => x.role);

        const userPayload = {
          id: authedUser.id,
          user_id: authedUser.id,
          email: authedUser.email ?? null,
          phone:
            (authedUser.user_metadata?.phone as string | undefined) ??
            authedUser.phone ??
            phone,
          display_name:
            (authedUser.user_metadata?.display_name as string | undefined) ??
            (authedUser.user_metadata?.name as string | undefined) ??
            (authedUser.user_metadata?.full_name as string | undefined) ??
            null,
          roles,
        };

        // 不带 install_id → Web 模式
        if (!body.install_id) {
          return ok({
            session: {
              access_token: session.access_token,
              refresh_token: session.refresh_token,
              expires_at: session.expires_at ?? 0,
            },
            user: userPayload,
          });
        }

        // 带 install_id → APP 模式，复用 bootstrap 后半段
        const install_id = body.install_id;
        const nowIso = new Date().toISOString();
        const { data: existing } = await supabaseAdmin
          .from("inv_handheld_devices" as never)
          .select("id, token")
          .eq("owner_user_id" as never, authedUser.id)
          .eq("install_id" as never, install_id)
          .maybeSingle();

        const patch: Record<string, unknown> = { last_seen_at: nowIso };
        if (body.capabilities) patch.capabilities = body.capabilities;
        if (body.app_version) patch.app_version = body.app_version;
        if (body.os_version) patch.os_version = body.os_version;
        if (body.device_label) patch.label = body.device_label;

        let deviceId: string;
        let deviceToken: string;
        if (existing) {
          deviceId = (existing as any).id as string;
          deviceToken = (existing as any).token as string;
          await supabaseAdmin
            .from("inv_handheld_devices" as never)
            .update(patch as never)
            .eq("id", deviceId);
        } else {
          deviceToken = genDeviceToken();
          const label =
            body.device_label ||
            ((authedUser.user_metadata?.name as string | undefined) ??
              authedUser.email ??
              "手持设备");
          let inserted: { id: string } | null = null;
          let lastErr: string | null = null;
          for (let i = 0; i < 3; i++) {
            const dcode = genDeviceCode();
            const { data: ins, error: insErr } = await supabaseAdmin
              .from("inv_handheld_devices" as never)
              .insert({
                device_code: dcode,
                label,
                token: deviceToken,
                is_active: true,
                owner_user_id: authedUser.id,
                install_id,
                capabilities: body.capabilities ?? {},
                app_version: body.app_version ?? null,
                os_version: body.os_version ?? null,
                last_seen_at: nowIso,
              } as never)
              .select("id")
              .maybeSingle();
            if (ins && !insErr) {
              inserted = ins as any;
              break;
            }
            lastErr = insErr?.message ?? null;
          }
          if (!inserted) return err(`Create device failed: ${lastErr ?? "unknown"}`, 500);
          deviceId = inserted.id;
        }

        const { data: deviceRow } = await supabaseAdmin
          .from("inv_handheld_devices")
          .select(
            "id, device_code, label, default_location_id, is_active, capabilities, app_version, os_version, location:inv_locations!default_location_id(id, kind, name)" as never,
          )
          .eq("id", deviceId)
          .maybeSingle();

        const { loadVisibleLocationsForDevice } = await import("@/server/handheld-auth.server");
        const { locations: locs, defaultLocationId } = await loadVisibleLocationsForDevice(
          deviceId,
          ((deviceRow as any)?.default_location_id as string | null) ?? null,
        );

        // 若刚刚自动绑定了默认库位，重新读 location 关联
        let loc = (deviceRow as any)?.location as
          | { id: string; kind: "warehouse" | "shop"; name: string }
          | null;
        if (!loc && defaultLocationId) {
          const { data: locRow } = await supabaseAdmin
            .from("inv_locations")
            .select("id, kind, name")
            .eq("id", defaultLocationId)
            .maybeSingle();
          loc = (locRow as any) ?? null;
        }
        const cap =
          ((deviceRow as any)?.capabilities as Record<string, unknown> | undefined) ?? {};
        const device_capabilities = {
          reader_model:
            cap.reader_model === "SUNMI_V3" || cap.reader_model === "RFID_PDA"
              ? (cap.reader_model as "SUNMI_V3" | "RFID_PDA")
              : ("UNKNOWN" as const),
          has_printer: cap.has_printer === true,
          has_rfid_reader: cap.has_rfid_reader === true,
          has_barcode_scanner: cap.has_barcode_scanner === true,
          has_camera: cap.has_camera !== false,
        };

        return ok({
          device_token: deviceToken,
          device: {
            id: deviceId,
            device_code: (deviceRow as any)?.device_code as string,
            label: (deviceRow as any)?.label as string,
            location_id: loc?.id ?? defaultLocationId,
            location_kind: loc?.kind ?? null,
            location_name: loc?.name ?? null,
            device_capabilities,
            app_version: ((deviceRow as any)?.app_version as string | null) ?? null,
            os_version: ((deviceRow as any)?.os_version as string | null) ?? null,
          },
          access_token: session.access_token,
          session_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_at: session.expires_at ?? 0,
          user: userPayload,
          locations: locs,
        });
      },
    },
  },
});
