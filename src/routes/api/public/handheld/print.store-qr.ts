// POST /api/public/handheld/print/store-qr  iOS 兼容入口
//   {action:'get',location_id} → {location_id,channels:[{channel,image_url,updated_at}],can_manage}
//   {action:'save',location_id,channel,image_base64,mime_type} 仅 super_admin；原图入私有桶 store-qr
import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  err,
  loadUserRoles,
  ok,
  resolveSessionUser,
  userCanAccessLocation,
} from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { QR_BUCKET, QR_MAX_BODY_BYTES, TOO_LARGE, readJsonCapped, printStoreQr, type QrPrintDeps } from "@/server/store-qr-print.server";
import type { QrRow } from "@/server/store-qr.server";

function deps(): QrPrintDeps {
  return {
    canAccessLocation: userCanAccessLocation,
    roles: loadUserRoles,
    list: async (loc) => {
      const { data, error } = await supabaseAdmin
        .from("store_qr_configs")
        .select("purpose,target_url,image_bucket,image_path,status,version,updated_at")
        .eq("location_id", loc);
      if (error) throw error;
      return (data ?? []) as QrRow[];
    },
    sign: async (bucket, path, ttl) => {
      const { data } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, ttl);
      return data?.signedUrl ?? null;
    },
    upload: async (path, bytes, mime) => {
      const { error } = await supabaseAdmin.storage.from(QR_BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
      if (error) throw error;
    },
    remove: async (path) => {
      await supabaseAdmin.storage.from(QR_BUCKET).remove([path]);
    },
    saveImage: async (row) => {
      const { data, error } = await supabaseAdmin
        .from("store_qr_configs")
        .upsert({ ...row, image_bucket: QR_BUCKET, status: "active" }, { onConflict: "location_id,purpose" })
        .select("updated_at,image_path")
        .maybeSingle();
      if (error) throw error;
      return data && data.image_path === row.image_path ? { updated_at: data.updated_at } : null;
    },
    newObjectId: () => crypto.randomUUID(),
  };
}

export const Route = createFileRoute("/api/public/handheld/print/store-qr")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        try {
          const auth = await authenticateDevice(request);
          if (!auth.ok) return auth.response;
          const session = await resolveSessionUser(request);
          if (!session) return err("Employee session required", 401, { code: "session_required" });
          const body = await readJsonCapped(request, QR_MAX_BODY_BYTES);
          if (body === TOO_LARGE) return err("Payload too large", 413, { code: "payload_too_large" });
          const r = await printStoreQr(deps(), session.user_id, body);
          return r.ok ? ok(r.body) : err(r.code, r.status, { code: r.code });
        } catch {
          return err("QR config unavailable", 500, { code: "internal_error" });
        }
      },
    },
  },
});
