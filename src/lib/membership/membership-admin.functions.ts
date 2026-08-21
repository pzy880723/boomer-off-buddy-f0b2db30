import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  presentMembershipAdminRow,
  type MembershipAdminCustomer,
  type MembershipAdminEntitlement,
} from "./membership-admin-presenter";

type AdminContext = { supabase: typeof supabaseAdmin; userId: string };
type DbRow = Record<string, unknown>;

async function assertSuperAdmin(context: AdminContext) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "super_admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("仅超级管理员可人工调整会员权益");
}

function rows<T>(data: unknown) {
  return (data ?? []) as T[];
}

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function hydrateMemberRows(customers: MembershipAdminCustomer[]) {
  const customerIds = customers.map((customer) => customer.id);
  if (customerIds.length === 0) return [];
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const [entitlementsResult, walletsResult, usageResult, couponsResult, consumptionResult] =
    await Promise.all([
      supabaseAdmin
        .from("commerce_membership_entitlements" as never)
        .select(
          "customer_id,tier_code,status,starts_at,expires_at,auto_renew,source,created_at,plan:commerce_membership_plans(code,display_name)",
        )
        .in("customer_id", customerIds)
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("pos_customer_wallets" as never)
        .select("customer_id,points")
        .in("customer_id", customerIds),
      supabaseAdmin
        .from("commerce_recognition_usage_daily" as never)
        .select("customer_id,used,allowance")
        .in("customer_id", customerIds)
        .eq("usage_date", shanghaiDate()),
      supabaseAdmin
        .from("pos_customer_coupons" as never)
        .select("customer_id")
        .in("customer_id", customerIds)
        .eq("status", "active"),
      supabaseAdmin
        .from("commerce_consumption_records" as never)
        .select("customer_id,paid_amount_fen")
        .in("customer_id", customerIds)
        .eq("status", "paid")
        .gte("occurred_at", ninetyDaysAgo),
    ]);

  for (const result of [
    entitlementsResult,
    walletsResult,
    usageResult,
    couponsResult,
    consumptionResult,
  ]) {
    if (result.error) throw new Error(result.error.message);
  }

  const entitlementByCustomer = new Map<string, MembershipAdminEntitlement>();
  for (const entitlement of rows<DbRow>(entitlementsResult.data)) {
    const customerId = String(entitlement.customer_id);
    if (!entitlementByCustomer.has(customerId)) {
      entitlementByCustomer.set(customerId, entitlement as MembershipAdminEntitlement);
    }
  }
  const pointsByCustomer = new Map(
    rows<DbRow>(walletsResult.data).map((wallet) => [
      String(wallet.customer_id),
      Number(wallet.points) || 0,
    ]),
  );
  const usageByCustomer = new Map(
    rows<DbRow>(usageResult.data).map((usage) => [
      String(usage.customer_id),
      { used: Number(usage.used) || 0, allowance: Number(usage.allowance) || 0 },
    ]),
  );
  const couponCountByCustomer = new Map<string, number>();
  for (const coupon of rows<DbRow>(couponsResult.data)) {
    const customerId = String(coupon.customer_id);
    couponCountByCustomer.set(customerId, (couponCountByCustomer.get(customerId) ?? 0) + 1);
  }
  const spendByCustomer = new Map<string, number>();
  for (const record of rows<DbRow>(consumptionResult.data)) {
    const customerId = String(record.customer_id);
    spendByCustomer.set(
      customerId,
      (spendByCustomer.get(customerId) ?? 0) + Number(record.paid_amount_fen || 0),
    );
  }

  return customers.map((customer) =>
    presentMembershipAdminRow({
      customer,
      entitlement: entitlementByCustomer.get(customer.id) ?? null,
      usage: usageByCustomer.get(customer.id) ?? null,
      points: pointsByCustomer.get(customer.id) ?? 0,
      couponCount: couponCountByCustomer.get(customer.id) ?? 0,
      spend90dFen: spendByCustomer.get(customer.id) ?? 0,
    }),
  );
}

export const getMembershipAdminSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const now = new Date();
    const inSevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const nowIso = now.toISOString();
    const [customers, paid, expiring, usage, coupons] = await Promise.all([
      supabaseAdmin
        .from("commerce_customers" as never)
        .select("id", { count: "exact", head: true })
        .neq("status", "deleted"),
      supabaseAdmin
        .from("commerce_membership_entitlements" as never)
        .select("id", { count: "exact", head: true })
        .eq("tier_code", "explorer")
        .eq("status", "active")
        .gt("expires_at", nowIso),
      supabaseAdmin
        .from("commerce_membership_entitlements" as never)
        .select("id", { count: "exact", head: true })
        .eq("tier_code", "explorer")
        .eq("status", "active")
        .gt("expires_at", nowIso)
        .lte("expires_at", inSevenDays),
      supabaseAdmin
        .from("commerce_recognition_usage_daily" as never)
        .select("used,allowance")
        .eq("usage_date", shanghaiDate())
        .limit(10000),
      supabaseAdmin
        .from("pos_customer_coupons" as never)
        .select("id,value", { count: "exact" })
        .eq("status", "active")
        .limit(10000),
    ]);
    for (const result of [customers, paid, expiring, usage, coupons]) {
      if (result.error) throw new Error(result.error.message);
    }
    const usageRows = rows<DbRow>(usage.data);
    const couponRows = rows<DbRow>(coupons.data);
    return {
      member_count: customers.count ?? 0,
      explorer_count: paid.count ?? 0,
      expiring_7d_count: expiring.count ?? 0,
      recognition_used_today: usageRows.reduce((sum, row) => sum + Number(row.used || 0), 0),
      recognition_allowance_today: usageRows.reduce(
        (sum, row) => sum + Number(row.allowance || 0),
        0,
      ),
      active_coupon_count: coupons.count ?? 0,
      active_coupon_value_fen: couponRows.reduce(
        (sum, row) => sum + Math.round(Number(row.value || 0) * 100),
        0,
      ),
    };
  });

export const listMembershipAdminMembers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        search: z.string().trim().max(100).optional(),
        tier: z.enum(["all", "free", "explorer"]).default("all"),
        status: z.enum(["all", "active", "expiring", "expired", "free"]).default("all"),
        limit: z.number().int().min(1).max(500).default(200),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    let query = supabaseAdmin
      .from("commerce_customers" as never)
      .select("id,external_subject,phone,nickname,avatar_url,status,created_at")
      .neq("status", "deleted")
      .order("created_at", { ascending: false })
      .limit(500);
    const needle = data.search?.replace(/[%_,()]/g, " ").trim();
    if (needle && !needle.toUpperCase().startsWith("BO")) {
      query = query.or(`phone.ilike.%${needle}%,nickname.ilike.%${needle}%`);
    }
    const { data: customerData, error } = await query;
    if (error) throw new Error(error.message);
    let memberRows = await hydrateMemberRows(rows<MembershipAdminCustomer>(customerData));
    if (needle?.toUpperCase().startsWith("BO")) {
      memberRows = memberRows.filter((row) => row.member_no.includes(needle.toUpperCase()));
    }
    if (data.tier !== "all") memberRows = memberRows.filter((row) => row.tier_code === data.tier);
    if (data.status !== "all") {
      memberRows = memberRows.filter((row) => row.expiry_state === data.status);
    }
    return { rows: memberRows.slice(0, data.limit), total: memberRows.length };
  });

export const getMembershipAdminDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ customer_id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { data: customerData, error } = await supabaseAdmin
      .from("commerce_customers" as never)
      .select("id,external_subject,phone,nickname,avatar_url,status,created_at")
      .eq("id", data.customer_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!customerData) throw new Error("会员不存在");
    const [member] = await hydrateMemberRows([customerData as unknown as MembershipAdminCustomer]);
    const [entitlements, points, coupons, consumption, audit] = await Promise.all([
      supabaseAdmin
        .from("commerce_membership_entitlements" as never)
        .select("*,plan:commerce_membership_plans(code,display_name,billing_period)")
        .eq("customer_id", data.customer_id)
        .order("created_at", { ascending: false })
        .limit(50),
      supabaseAdmin
        .from("commerce_points_ledger" as never)
        .select("*")
        .eq("customer_id", data.customer_id)
        .order("created_at", { ascending: false })
        .limit(100),
      supabaseAdmin
        .from("pos_customer_coupons" as never)
        .select("*")
        .eq("customer_id", data.customer_id)
        .order("created_at", { ascending: false })
        .limit(100),
      supabaseAdmin
        .from("commerce_consumption_records" as never)
        .select("*")
        .eq("customer_id", data.customer_id)
        .order("occurred_at", { ascending: false })
        .limit(100),
      supabaseAdmin
        .from("commerce_membership_admin_audit_logs" as never)
        .select("*")
        .eq("customer_id", data.customer_id)
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
    for (const result of [entitlements, points, coupons, consumption, audit]) {
      if (result.error) throw new Error(result.error.message);
    }
    return {
      member,
      entitlements: entitlements.data ?? [],
      points: points.data ?? [],
      coupons: coupons.data ?? [],
      consumption: consumption.data ?? [],
      audit: audit.data ?? [],
    };
  });

function createAdminListFunction(table: string, orderColumn: string) {
  return createServerFn({ method: "GET" })
    .middleware([requireSupabaseAuth])
    .inputValidator((input: unknown) =>
      z.object({ limit: z.number().int().min(1).max(500).default(200) }).parse(input ?? {}),
    )
    .handler(async ({ data }) => {
      const { data: result, error } = await supabaseAdmin
        .from(table as never)
        .select("*")
        .order(orderColumn, { ascending: false })
        .limit(data.limit);
      if (error) throw new Error(error.message);
      return { rows: result ?? [] };
    });
}

export const listMembershipAdminPlans = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const [plans, coupons] = await Promise.all([
      supabaseAdmin
        .from("commerce_membership_plans" as never)
        .select("*")
        .order("amount_fen", { ascending: true }),
      supabaseAdmin
        .from("commerce_coupon_definitions" as never)
        .select("*")
        .order("created_at", { ascending: false }),
    ]);
    if (plans.error) throw new Error(plans.error.message);
    if (coupons.error) throw new Error(coupons.error.message);
    return { rows: plans.data ?? [], coupon_definitions: coupons.data ?? [] };
  });

export const listMembershipAdminCoupons = createAdminListFunction(
  "pos_customer_coupons",
  "created_at",
);
export const listMembershipAdminPoints = createAdminListFunction(
  "commerce_points_ledger",
  "created_at",
);
export const listMembershipAdminConsumption = createAdminListFunction(
  "commerce_consumption_records",
  "occurred_at",
);
export const listMembershipAdminAudit = createAdminListFunction(
  "commerce_membership_admin_audit_logs",
  "created_at",
);

const adjustmentSchema = z.object({
  customer_id: z.string().uuid(),
  action: z.enum(["entitlement", "points", "coupon"]),
  payload: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(2, "请填写至少 2 个字的调整原因").max(500),
  reference: z.string().trim().max(100).optional(),
  idempotency_key: z.string().trim().min(8).max(120),
});

export const adjustMembershipAdminBenefit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => adjustmentSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context as AdminContext);
    const { data: result, error } = await supabaseAdmin.rpc(
      "commerce_admin_adjust_membership" as never,
      {
        p_operator_id: (context as AdminContext).userId,
        p_customer_id: data.customer_id,
        p_action: data.action,
        p_payload: data.payload,
        p_reason: data.reason,
        p_reference: data.reference ?? null,
        p_idempotency_key: data.idempotency_key,
      } as never,
    );
    if (error) throw new Error(error.message);
    return result;
  });
