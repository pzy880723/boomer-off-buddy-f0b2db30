/** 尺寸测量员工身份：角色 + 授权门店（服务端专用，不进浏览器包） */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { MeasurementActor } from "@/server/product-measurement.server";

/** 读取失败时抛出的受控错误（调用方映射为“服务暂时不可用”，不得当作无权限/无任务） */
export const MEASUREMENT_ACTOR_UNAVAILABLE = "measurement_actor_unavailable";

export async function loadMeasurementActor(userId: string): Promise<MeasurementActor> {
  const { data: roleRows, error: roleError } = await supabaseAdmin
    .from("user_roles" as never)
    .select("role")
    .eq("user_id", userId);
  if (roleError) {
    console.error("[measurement-actor] roles", roleError.message);
    throw new Error(MEASUREMENT_ACTOR_UNAVAILABLE);
  }
  const roles = ((roleRows as { role: string }[] | null) ?? []).map((r) => r.role);
  const isHq = roles.includes("super_admin") || roles.includes("hq_operator");
  let locationIds: string[] = [];
  if (!isHq) {
    const { data, error } = await supabaseAdmin
      .from("user_location_perms" as never)
      .select("location_id")
      .eq("user_id", userId);
    if (error) {
      console.error("[measurement-actor] perms", error.message);
      throw new Error(MEASUREMENT_ACTOR_UNAVAILABLE);
    }
    locationIds = ((data as { location_id: string }[] | null) ?? []).map((p) => p.location_id);
  }
  return { userId, roles, locationIds };
}
