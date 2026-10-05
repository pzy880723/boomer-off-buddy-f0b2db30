// GET /api/public/handheld/store/qr-configs?location_id=   门店二维码配置（员工按库位只读）
// PUT /api/public/handheld/store/qr-configs                 仅 super_admin 写；不支持上传图片
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
import { listStoreQr, saveStoreQr, type QrDeps, type QrRow } from "@/server/store-qr.server";

const COLS = "purpose,target_url,image_bucket,image_path,status,version,updated_at";

function deps(): QrDeps {
  return {
    canAccessLocation: userCanAccessLocation,
    roles: loadUserRoles,
    list: async (locationId) => {
      const { data, error } = await supabaseAdmin.from("store_qr_configs").select(COLS).eq("location_id", locationId);
      if (error) throw error;
      return (data ?? []) as QrRow[];
    },
    sign: async (bucket, path) => {
      const { data } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, 600);
      return data?.signedUrl ?? null;
    },
    upsert: async (row) => {
      const { data, error } = await supabaseAdmin
        .from("store_qr_configs")
        .upsert(row, { onConflict: "location_id,purpose" })
        .select(COLS)
        .maybeSingle();
      if (error) throw error;
      return data as QrRow | null;
    },
  };
}

export const Route = createFileRoute("/api/public/handheld/store/qr-configs")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        try {
          const auth = await authenticateDevice(request);
          if (!auth.ok) return auth.response;
          const session = await resolveSessionUser(request);
          if (!session) return err("Employee session required", 401, { code: "session_required" });
          const loc = new URL(request.url).searchParams.get("location_id") ?? auth.device.location_id;
          if (!loc) return err("Location required", 422, { code: "validation_error" });
          const r = await listStoreQr(deps(), session.user_id, loc);
          return r.ok ? ok({ location_id: loc, items: r.items }) : err(r.code, r.status, { code: r.code });
        } catch {
          return err("QR config unavailable", 500, { code: "internal_error" });
        }
      },
      PUT: async ({ request }) => {
        try {
          const auth = await authenticateDevice(request);
          if (!auth.ok) return auth.response;
          const session = await resolveSessionUser(request);
          if (!session) return err("Employee session required", 401, { code: "session_required" });
          const r = await saveStoreQr(deps(), session.user_id, await request.json().catch(() => null));
          return r.ok ? ok(r.item) : err(r.code, r.status, { code: r.code });
        } catch {
          return err("QR config unavailable", 500, { code: "internal_error" });
        }
      },
    },
  },
});
