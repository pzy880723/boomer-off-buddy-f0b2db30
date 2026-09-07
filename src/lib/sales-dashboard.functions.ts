/**
 * 销售仪表盘只读 API。
 * 总部（super_admin / hq_operator）可看全部或指定门店；其他账号仅限被授权门店。
 * 授权在服务端强制执行，前端传参不可信。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveLocationScope, resolveRange } from "@/lib/sales-dashboard/contract";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式 yyyy-mm-dd");

const inputSchema = z.object({
  range: z.enum(["today", "yesterday", "month", "custom"]),
  start: dateSchema.optional(),
  end: dateSchema.optional(),
  location_id: z.union([z.literal("all"), z.string().uuid()]).optional(),
});

export type SalesDashboardInput = z.infer<typeof inputSchema>;

export const getSalesDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => inputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { data: roleRows, error: roleError } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleError) throw new Error(`读取角色失败：${roleError.message}`);
    const roles = ((roleRows as { role: string }[] | null) ?? []).map((r) => r.role);
    const isHq = roles.includes("super_admin") || roles.includes("hq_operator");

    const { data: locationRows, error: locError } = await context.supabase
      .from("inv_locations")
      .select("id, name, shop_id, is_active, kind")
      .eq("is_active", true)
      .order("name");
    if (locError) throw new Error(`读取门店失败：${locError.message}`);
    const locations = (
      (locationRows as { id: string; name: string; shop_id: string | null }[] | null) ?? []
    ).map((l) => ({ id: l.id, name: l.name, shop_id: l.shop_id ?? null }));

    let allowedLocationIds: string[];
    if (isHq) {
      allowedLocationIds = locations.map((l) => l.id);
    } else {
      const { data: perms, error: permError } = await context.supabase
        .from("user_location_perms")
        .select("location_id")
        .eq("user_id", context.userId);
      if (permError) throw new Error(`读取门店权限失败：${permError.message}`);
      allowedLocationIds = ((perms as { location_id: string }[] | null) ?? []).map(
        (p) => p.location_id,
      );
    }

    const scope = resolveLocationScope({
      requested: data.location_id,
      isHq,
      allowedLocationIds,
    });
    const range = resolveRange({ range: data.range, start: data.start, end: data.end });

    const visibleLocations = isHq
      ? locations
      : locations.filter((l) => allowedLocationIds.includes(l.id));

    const { loadSalesDashboard } = await import("@/server/sales-dashboard.server");
    return loadSalesDashboard({ range, scope, locations: visibleLocations });
  });
