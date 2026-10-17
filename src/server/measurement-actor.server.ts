/** 尺寸测量员工身份：角色 + 授权门店（服务端专用，不进浏览器包） */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadUserRoles } from "@/server/handheld-auth.server";
import type { MeasurementActor } from "@/server/product-measurement.server";

export async function loadMeasurementActor(userId: string): Promise<MeasurementActor> {
  const roles = await loadUserRoles(userId);
  const isHq = roles.includes("super_admin") || roles.includes("hq_operator");
  let locationIds: string[] = [];
  if (!isHq) {
    const { data } = await supabaseAdmin
      .from("user_location_perms" as never)
      .select("location_id")
      .eq("user_id", userId);
    locationIds = ((data as { location_id: string }[] | null) ?? []).map((p) => p.location_id);
  }
  return { userId, roles, locationIds };
}
