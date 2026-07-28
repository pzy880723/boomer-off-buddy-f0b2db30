import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const POS_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
  "Access-Control-Max-Age": "86400",
};

export function posJson(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...POS_CORS,
      ...(init.headers || {}),
    },
  });
}

export function posError(message: string, status = 400, code?: string) {
  return posJson({ ok: false, message, ...(code ? { code } : {}) }, { status });
}

type PosLocation = {
  id: string;
  name: string;
  kind: "warehouse" | "shop";
};

const POS_ROLES = new Set(["super_admin", "hq_operator", "store_manager", "store_staff"]);
const POS_MANAGER_ROLES = new Set(["super_admin", "hq_operator", "store_manager"]);

export function hasPosManagerRole(roles: string[]) {
  return roles.some((role) => POS_MANAGER_ROLES.has(role));
}

export async function authenticatePosUser(
  request: Request,
  requiredLocationId?: string,
): Promise<
  | {
      ok: true;
      user: { id: string; email: string | null };
      roles: string[];
      locations: PosLocation[];
    }
  | { ok: false; response: Response }
> {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, response: posError("请先登录 ERP", 401, "unauthorized") };

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    return { ok: false, response: posError("ERP 登录已失效", 401, "unauthorized") };
  }
  const { data: roleRows, error: roleError } = await supabaseAdmin
    .from("user_roles" as never)
    .select("role")
    .eq("user_id", data.user.id);
  if (roleError) return { ok: false, response: posError(roleError.message, 500) };
  const roles = ((roleRows ?? []) as unknown as Array<{ role: string }>).map((row) => row.role);
  if (!roles.some((role) => POS_ROLES.has(role))) {
    return { ok: false, response: posError("当前账号没有收银权限", 403, "forbidden") };
  }

  const isHq = roles.includes("super_admin") || roles.includes("hq_operator");
  let locationQuery = supabaseAdmin
    .from("inv_locations")
    .select("id,name,kind")
    .eq("is_active", true);
  if (!isHq) {
    const { data: permissionRows, error: permissionError } = await supabaseAdmin
      .from("user_location_perms" as never)
      .select("location_id")
      .eq("user_id", data.user.id);
    if (permissionError) return { ok: false, response: posError(permissionError.message, 500) };
    const locationIds = ((permissionRows ?? []) as unknown as Array<{ location_id: string }>).map(
      (row) => row.location_id,
    );
    if (locationIds.length === 0) {
      return {
        ok: false,
        response: posError("当前账号未授权任何库位", 403, "location_forbidden"),
      };
    }
    locationQuery = locationQuery.in("id", locationIds);
  }
  const { data: locations, error: locationError } = await locationQuery;
  if (locationError) return { ok: false, response: posError(locationError.message, 500) };
  const visibleLocations = (locations ?? []) as PosLocation[];
  if (
    requiredLocationId &&
    !visibleLocations.some((location) => location.id === requiredLocationId)
  ) {
    return {
      ok: false,
      response: posError("无权在该库位进行收银", 403, "location_forbidden"),
    };
  }
  return {
    ok: true,
    user: { id: data.user.id, email: data.user.email ?? null },
    roles,
    locations: visibleLocations,
  };
}
