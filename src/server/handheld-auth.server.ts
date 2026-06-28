// Shared helpers for /api/public/handheld/* route handlers.
// Server-only: do not import from client code.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const HANDHELD_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Device-Token, X-Session-Token, Authorization",
  "Access-Control-Max-Age": "86400",
};


export function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...HANDHELD_CORS,
      ...(init.headers || {}),
    },
  });
}

export function ok<T>(data: T) {
  return json({ ok: true, data });
}

export function err(message: string, status = 400, extra?: Record<string, unknown>) {
  return json({ ok: false, error: message, ...(extra || {}) }, { status });
}

export type DeviceContext = {
  id: string;
  device_code: string;
  label: string;
  location_id: string | null;
  location_kind: "warehouse" | "shop" | null;
  location_name: string | null;
};

export async function authenticateDevice(request: Request): Promise<
  | { ok: true; device: DeviceContext }
  | { ok: false; response: Response }
> {
  const token = request.headers.get("x-device-token") || request.headers.get("X-Device-Token");
  if (!token) {
    return { ok: false, response: err("Missing X-Device-Token", 401) };
  }
  const { data, error } = await supabaseAdmin
    .from("inv_handheld_devices")
    .select(
      "id, device_code, label, default_location_id, is_active, location:inv_locations!default_location_id(id, kind, name)"
    )
    .eq("token", token)
    .maybeSingle();

  if (error || !data) {
    return { ok: false, response: err("Invalid token", 401) };
  }
  if (!data.is_active) {
    return { ok: false, response: err("Device disabled", 403) };
  }
  // Best-effort heartbeat
  void supabaseAdmin
    .from("inv_handheld_devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", data.id);

  const loc = (data as any).location as
    | { id: string; kind: "warehouse" | "shop"; name: string }
    | null;

  return {
    ok: true,
    device: {
      id: data.id as string,
      device_code: data.device_code as string,
      label: data.label as string,
      location_id: loc?.id ?? null,
      location_kind: loc?.kind ?? null,
      location_name: loc?.name ?? null,
    },
  };
}

export function requireLocation(d: DeviceContext): { ok: true } | { ok: false; response: Response } {
  if (!d.location_id) return { ok: false, response: err("Device has no bound location", 400) };
  return { ok: true };
}

export function requireWarehouse(d: DeviceContext): { ok: true } | { ok: false; response: Response } {
  const need = requireLocation(d);
  if (!need.ok) return need;
  if (d.location_kind !== "warehouse")
    return { ok: false, response: err("This operation requires a warehouse device", 403) };
  return { ok: true };
}

/** Optional: 解析 X-Session-Token / Authorization，拿到操作员 user_id。失败返回 null（不强制）。 */
export async function resolveSessionUser(request: Request): Promise<{
  user_id: string;
  email: string | null;
} | null> {
  const raw =
    request.headers.get("x-session-token") ||
    request.headers.get("X-Session-Token") ||
    (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
    null;
  if (!raw) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(raw);
  if (error || !data?.user) return null;
  return { user_id: data.user.id, email: data.user.email ?? null };
}

