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

export type DeviceCapabilities = {
  reader_model: "SUNMI_V3" | "RFID_PDA" | "UNKNOWN";
  has_printer: boolean;
  has_rfid_reader: boolean;
  has_barcode_scanner: boolean;
  has_camera: boolean;
};

const DEFAULT_DEVICE_CAPABILITIES: DeviceCapabilities = {
  reader_model: "UNKNOWN",
  has_printer: false,
  has_rfid_reader: false,
  has_barcode_scanner: false,
  has_camera: true,
};

function normalizeCapabilities(raw: unknown): DeviceCapabilities {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DEVICE_CAPABILITIES };
  const r = raw as Record<string, unknown>;
  const reader = r.reader_model;
  return {
    reader_model:
      reader === "SUNMI_V3" || reader === "RFID_PDA" || reader === "UNKNOWN"
        ? reader
        : "UNKNOWN",
    has_printer: r.has_printer === true,
    has_rfid_reader: r.has_rfid_reader === true,
    has_barcode_scanner: r.has_barcode_scanner === true,
    has_camera: r.has_camera !== false,
  };
}

export type DeviceContext = {
  id: string;
  device_code: string;
  label: string;
  location_id: string | null;
  location_kind: "warehouse" | "shop" | null;
  location_name: string | null;
  device_capabilities: DeviceCapabilities;
  app_version: string | null;
  os_version: string | null;
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
      "id, device_code, label, default_location_id, is_active, capabilities, app_version, os_version, location:inv_locations!default_location_id(id, kind, name)" as never,
    )
    .eq("token", token)
    .maybeSingle();

  if (error || !data) {
    return { ok: false, response: err("Invalid token", 401) };
  }
  if (!(data as any).is_active) {
    return { ok: false, response: err("Device disabled", 403) };
  }
  // Best-effort heartbeat
  void supabaseAdmin
    .from("inv_handheld_devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", (data as any).id);

  const loc = (data as any).location as
    | { id: string; kind: "warehouse" | "shop"; name: string }
    | null;

  return {
    ok: true,
    device: {
      id: (data as any).id as string,
      device_code: (data as any).device_code as string,
      label: (data as any).label as string,
      location_id: loc?.id ?? null,
      location_kind: loc?.kind ?? null,
      location_name: loc?.name ?? null,
      device_capabilities: normalizeCapabilities((data as any).capabilities),
      app_version: ((data as any).app_version as string | null) ?? null,
      os_version: ((data as any).os_version as string | null) ?? null,
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

/**
 * 加载 APP 可见的库位：is_active=true，按 kind（warehouse 在前）+ name 排序。
 * 如果 device 当前没有绑定默认库位，且可见库位刚好只有一个，则自动绑定，
 * 让 APP 登录后跳过"选择库位"这一步。
 * 返回 { locations, defaultLocationId }，调用方据此填充返回包里的 device.location_*。
 */
export async function loadVisibleLocationsForDevice(
  deviceId: string | null,
  currentDefaultLocationId: string | null,
  userId?: string | null,
): Promise<{
  locations: { id: string; name: string; kind: "warehouse" | "shop"; is_active: boolean }[];
  defaultLocationId: string | null;
}> {
  let isHq = false;
  if (userId) {
    const roles = await loadUserRoles(userId);
    isHq = roles.includes("super_admin") || roles.includes("hq_operator");
  }

  let allowedIds: string[] | null = null;
  if (userId && !isHq) {
    const { data: perms } = await supabaseAdmin
      .from("user_location_perms" as never)
      .select("location_id")
      .eq("user_id", userId);
    allowedIds = ((perms as { location_id: string }[] | null) ?? []).map((p) => p.location_id);
    if (allowedIds.length === 0) {
      // 非 HQ 用户尚未授权任何库位 → 空列表，清掉历史默认库位
      if (deviceId && currentDefaultLocationId) {
        await supabaseAdmin
          .from("inv_handheld_devices")
          .update({ default_location_id: null })
          .eq("id", deviceId);
      }
      return { locations: [], defaultLocationId: null };
    }
  }

  let query = supabaseAdmin
    .from("inv_locations")
    .select("id, name, kind, is_active")
    .eq("is_active", true);
  if (allowedIds) query = query.in("id", allowedIds);

  const { data } = await query;
  const rows = (data ?? []) as {
    id: string;
    name: string;
    kind: "warehouse" | "shop";
    is_active: boolean;
  }[];
  rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "warehouse" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });

  // 如果当前默认库位已不在可见范围（停用 / 撤权）→ 清空
  let defaultLocationId = currentDefaultLocationId;
  if (defaultLocationId && !rows.some((r) => r.id === defaultLocationId)) {
    defaultLocationId = null;
    if (deviceId) {
      await supabaseAdmin
        .from("inv_handheld_devices")
        .update({ default_location_id: null })
        .eq("id", deviceId);
    }
  }
  if (deviceId && !defaultLocationId && rows.length === 1) {
    defaultLocationId = rows[0].id;
    await supabaseAdmin
      .from("inv_handheld_devices")
      .update({ default_location_id: defaultLocationId })
      .eq("id", deviceId);
  }
  return { locations: rows, defaultLocationId };
}

/** 读取用户角色列表（字符串数组） */
export async function loadUserRoles(userId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("user_roles" as never)
    .select("role")
    .eq("user_id", userId);
  return ((data as { role: string }[] | null) ?? []).map((r) => r.role);
}

/** 当前用户是否有权操作指定 location（HQ 角色全通） */
export async function userCanAccessLocation(
  userId: string,
  locationId: string,
): Promise<boolean> {
  const roles = await loadUserRoles(userId);
  if (roles.includes("super_admin") || roles.includes("hq_operator")) return true;
  const { data } = await supabaseAdmin
    .from("user_location_perms" as never)
    .select("location_id")
    .eq("user_id", userId)
    .eq("location_id", locationId)
    .maybeSingle();
  return !!data;
}


