// ERP 后台（总部）门店目标配置。店员端一律只读，写操作仅 super_admin / hq_operator。
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const monthSchema = z.string().regex(/^\d{4}-\d{2}$/, "月份格式 yyyy-mm");
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式 yyyy-mm-dd");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function requireHq(context: { supabase: any; userId: string }) {
  const { data } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId);
  const roles = ((data as { role: string }[] | null) ?? []).map((r) => r.role);
  const isHq = roles.includes("super_admin") || roles.includes("hq_operator");
  if (!isHq) throw new Error("仅总部可配置门店目标");
  return roles[0] ?? null;
}

export const listTargetLocations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("inv_locations")
      .select("id, name, kind, shop_id, is_active")
      .eq("is_active", true)
      .order("name");
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const getMonthlyTargetPlan = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { location_id: string; month: string }) =>
    z.object({ location_id: z.string().uuid(), month: monthSchema }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const periodMonth = `${data.month}-01`;
    const { data: plan } = await context.supabase
      .from("store_monthly_target_plans")
      .select("*")
      .eq("location_id", data.location_id)
      .eq("period_month", periodMonth)
      .eq("status", "published")
      .maybeSingle();

    const { data: days } = await context.supabase
      .from("store_daily_targets")
      .select("target_date, target_amount_fen, source, is_locked, weight, plan_version")
      .eq("location_id", data.location_id)
      .gte("target_date", periodMonth)
      .lte("target_date", `${data.month}-31`)
      .order("target_date");

    return { plan: plan ?? null, days: days ?? [] };
  });

export const publishMonthlyTargetPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        location_id: z.string().uuid(),
        month: monthSchema,
        monthly_target_fen: z.number().int().min(0),
        weekday_weights: z.record(z.string(), z.number().min(0)).optional(),
        date_weight_overrides: z.record(dateSchema, z.number().min(0)).optional(),
        closed_dates: z.array(dateSchema).optional(),
        note: z.string().nullable().optional(),
        reason: z.string().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const role = await requireHq(context);
    const { publishMonthlyPlan } = await import("@/server/store-targets.server");
    const result = await publishMonthlyPlan(
      {
        locationId: data.location_id,
        month: data.month,
        monthlyTargetFen: data.monthly_target_fen,
        weekdayWeights: data.weekday_weights,
        dateWeightOverrides: data.date_weight_overrides,
        closedDates: data.closed_dates,
        note: data.note ?? null,
        reason: data.reason ?? null,
      },
      { actorId: context.userId, actorRole: role },
    );
    return {
      plan_id: result.plan.id as string,
      version: result.plan.version as number,
      written_days: result.written_days,
      total_fen: result.allocation.total_fen,
      frozen_fen: result.allocation.frozen_fen,
      warnings: result.allocation.warnings,
    };
  });

export const setDailyTargetOverride = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        location_id: z.string().uuid(),
        date: dateSchema,
        target_amount_fen: z.number().int().min(0),
        lock: z.boolean().optional(),
        note: z.string().nullable().optional(),
        reason: z.string().min(1, "请填写调整原因"),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const role = await requireHq(context);
    const { overrideDailyTarget } = await import("@/server/store-targets.server");
    const row = await overrideDailyTarget(
      {
        locationId: data.location_id,
        date: data.date,
        targetAmountFen: data.target_amount_fen,
        lock: data.lock ?? true,
        note: data.note ?? null,
        reason: data.reason,
      },
      { actorId: context.userId, actorRole: role },
    );
    return { id: row.id as string };
  });

export const getStoreDailySummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { location_id: string; date?: string }) =>
    z.object({ location_id: z.string().uuid(), date: dateSchema.optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: perm } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    const roles = ((perm as { role: string }[] | null) ?? []).map((r) => r.role);
    if (!roles.includes("super_admin") && !roles.includes("hq_operator")) {
      const { data: locPerm } = await context.supabase
        .from("user_location_perms")
        .select("location_id")
        .eq("user_id", context.userId)
        .eq("location_id", data.location_id)
        .maybeSingle();
      if (!locPerm) throw new Error("无权查看该门店数据");
    }
    const { loadDailySummary } = await import("@/server/store-targets.server");
    return loadDailySummary({ locationId: data.location_id, date: data.date });
  });

export const listTargetAuditLogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { location_id: string; limit?: number }) =>
    z
      .object({
        location_id: z.string().uuid(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireHq(context);
    const { data: rows, error } = await context.supabase
      .from("store_target_audit_logs")
      .select("id, entity_type, action, period_month, target_date, reason, actor_id, created_at")
      .eq("location_id", data.location_id)
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 20);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
