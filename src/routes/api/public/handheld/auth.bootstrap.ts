import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { HANDHELD_CORS, ok, err, loadVisibleLocationsForDevice } from "@/server/handheld-auth.server";
import { BootstrapReq } from "@/lib/handheld/schemas";
import { phoneToEmail, PHONE_REGEX } from "@/lib/auth-config";

function genDeviceCode() {
  // HH-XXXXXXXX
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `HH-${s}`;
}

function genToken() {
  // 40-char URL-safe
  const bytes = new Uint8Array(30);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export const Route = createFileRoute("/api/public/handheld/auth/bootstrap")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        let body: ReturnType<typeof BootstrapReq.parse>;
        try {
          body = BootstrapReq.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { code: "invalid_body", detail: String(e) });
        }

        // 1. Verify ERP credentials
        const sb = createClient(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_PUBLISHABLE_KEY!,
          { auth: { persistSession: false, autoRefreshToken: false } },
        );
        // 统一走 phoneToEmail 伪邮箱方案，避免依赖 Supabase 原生 phone provider。
        let email: string;
        if (body.email) {
          email = body.email;
        } else {
          const phone = (body.phone ?? "").trim();
          if (!PHONE_REGEX.test(phone)) {
            return err("手机号格式不正确", 400, { code: "invalid_body" });
          }
          email = phoneToEmail(phone);
        }
        const { data: signIn, error: signInErr } = await sb.auth.signInWithPassword({
          email,
          password: body.password,
        });
        if (signInErr || !signIn.session || !signIn.user) {
          return err(signInErr?.message || "Invalid credentials", 401, { code: "unauthorized" });
        }
        const user = signIn.user;
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // 2. Upsert device by (owner_user_id, install_id)
        const { data: existing } = await supabaseAdmin
          .from("inv_handheld_devices" as never)
          .select("id, token, default_location_id, device_code, label")
          .eq("owner_user_id" as never, user.id)
          .eq("install_id" as never, body.install_id)
          .maybeSingle();

        let deviceId: string;
        let deviceToken: string;
        const nowIso = new Date().toISOString();
        const patch: Record<string, unknown> = {
          last_seen_at: nowIso,
        };
        if (body.capabilities) patch.capabilities = body.capabilities;
        if (body.app_version) patch.app_version = body.app_version;
        if (body.os_version) patch.os_version = body.os_version;
        if (body.device_label) patch.label = body.device_label;

        if (existing) {
          deviceId = (existing as any).id as string;
          deviceToken = (existing as any).token as string;
          await supabaseAdmin
            .from("inv_handheld_devices" as never)
            .update(patch as never)
            .eq("id", deviceId);
        } else {
          deviceToken = genToken();
          const label =
            body.device_label ||
            ((user.user_metadata?.name as string | undefined) ?? user.email ?? "手持设备");
          // Retry device_code up to 3x on conflict
          let inserted: { id: string } | null = null;
          let lastErr: string | null = null;
          for (let i = 0; i < 3; i++) {
            const code = genDeviceCode();
            const { data: ins, error: insErr } = await supabaseAdmin
              .from("inv_handheld_devices" as never)
              .insert(
                {
                  device_code: code,
                  label,
                  token: deviceToken,
                  is_active: true,
                  owner_user_id: user.id,
                  install_id: body.install_id,
                  capabilities: body.capabilities ?? {},
                  app_version: body.app_version ?? null,
                  os_version: body.os_version ?? null,
                  last_seen_at: nowIso,
                } as never,
              )
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

        // 3. Reload device with location join
        const { data: deviceRow } = await supabaseAdmin
          .from("inv_handheld_devices")
          .select(
            "id, device_code, label, default_location_id, is_active, capabilities, app_version, os_version, location:inv_locations!default_location_id(id, kind, name)" as never,
          )
          .eq("id", deviceId)
          .maybeSingle();

        const loc = (deviceRow as any)?.location as
          | { id: string; kind: "warehouse" | "shop"; name: string }
          | null;

        const cap = ((deviceRow as any)?.capabilities as Record<string, unknown> | undefined) ?? {};
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

        // 4. Roles + locations
        const { data: roleRows } = await supabaseAdmin
          .from("user_roles" as never)
          .select("role")
          .eq("user_id", user.id);
        const roles = ((roleRows as { role: string }[] | null) ?? []).map((r) => r.role);

        const { data: locs } = await supabaseAdmin
          .from("inv_locations")
          .select("id, name, kind, is_active")
          .eq("is_active", true)
          .order("kind")
          .order("name");

        return ok({
          device_token: deviceToken,
          device: {
            id: deviceId,
            device_code: (deviceRow as any)?.device_code as string,
            label: (deviceRow as any)?.label as string,
            location_id: loc?.id ?? null,
            location_kind: loc?.kind ?? null,
            location_name: loc?.name ?? null,
            device_capabilities,
            app_version: ((deviceRow as any)?.app_version as string | null) ?? null,
            os_version: ((deviceRow as any)?.os_version as string | null) ?? null,
          },
          access_token: signIn.session.access_token,
          session_token: signIn.session.access_token,
          refresh_token: signIn.session.refresh_token,
          expires_at: signIn.session.expires_at ?? 0,
          user: {
            user_id: user.id,
            email: user.email ?? null,
            display_name:
              (user.user_metadata?.display_name as string | undefined) ??
              (user.user_metadata?.name as string | undefined) ??
              (user.user_metadata?.full_name as string | undefined) ??
              null,
            roles,
          },
          locations: locs ?? [],
        });
      },
    },
  },
});
