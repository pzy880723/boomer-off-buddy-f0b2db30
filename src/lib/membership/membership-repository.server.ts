import { createHash, randomBytes } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { presentMembershipAccount, presentMembershipPlan } from "./membership-presenter";

function shanghaiDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function fail(error: { message: string } | null, fallback: string): never {
  throw new Error(error?.message ?? fallback);
}

export async function getMembershipAccount(customerId: string) {
  const now = new Date().toISOString();
  const today = shanghaiDate();
  const [entitlementResult, freePlanResult, walletResult, usageResult, couponResult] =
    await Promise.all([
      supabaseAdmin
        .from("commerce_membership_entitlements" as never)
        .select(
          "id,expires_at,auto_renew,source,plan:commerce_membership_plans(tier_code,daily_recognition_limit,official_discount_rate,points_multiplier,points_redemption_cap_rate,policy_version)",
        )
        .eq("customer_id", customerId)
        .eq("status", "active")
        .lte("starts_at", now)
        .or(`expires_at.is.null,expires_at.gt.${now}`)
        .order("expires_at", { ascending: false, nullsFirst: true })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("commerce_membership_plans" as never)
        .select(
          "tier_code,daily_recognition_limit,official_discount_rate,points_multiplier,points_redemption_cap_rate,policy_version",
        )
        .eq("code", "free")
        .eq("is_active", true)
        .single(),
      supabaseAdmin
        .from("pos_customer_wallets" as never)
        .select("points")
        .eq("customer_id", customerId)
        .maybeSingle(),
      supabaseAdmin
        .from("commerce_recognition_usage_daily" as never)
        .select("used,allowance")
        .eq("customer_id", customerId)
        .eq("usage_date", today)
        .maybeSingle(),
      supabaseAdmin
        .from("pos_customer_coupons" as never)
        .select("id", { count: "exact", head: true })
        .eq("customer_id", customerId)
        .eq("status", "active")
        .or(`expires_at.is.null,expires_at.gt.${now}`),
    ]);

  if (entitlementResult.error) fail(entitlementResult.error, "Membership entitlement unavailable");
  if (freePlanResult.error) fail(freePlanResult.error, "Free membership policy unavailable");
  if (walletResult.error) fail(walletResult.error, "Membership wallet unavailable");
  if (usageResult.error) fail(usageResult.error, "Recognition usage unavailable");
  if (couponResult.error) fail(couponResult.error, "Membership coupons unavailable");

  const entitlement = entitlementResult.data as unknown as {
    expires_at: string | null;
    auto_renew: boolean;
    source: string;
    plan: Record<string, unknown> | null;
  } | null;
  const freePlan = freePlanResult.data as unknown as Record<string, unknown>;
  const wallet = walletResult.data as unknown as { points: number } | null;
  const usage = usageResult.data as unknown as { used: number; allowance: number } | null;

  return presentMembershipAccount({
    plan: (entitlement?.plan ?? freePlan) as never,
    entitlement,
    usage,
    pointsBalance: wallet?.points ?? 0,
    couponCount: couponResult.count ?? 0,
  });
}

export async function listMembershipPlans(platform: string) {
  const { data, error } = await supabaseAdmin
    .from("commerce_membership_plans" as never)
    .select(
      "id,code,tier_code,billing_period,amount_fen,renewal_amount_fen,daily_recognition_limit,official_discount_rate,points_multiplier,points_redemption_cap_rate",
    )
    .eq("tier_code", "explorer")
    .eq("is_active", true)
    .order("amount_fen", { ascending: true });
  if (error) fail(error, "Membership plans unavailable");
  return ((data ?? []) as unknown as Array<Parameters<typeof presentMembershipPlan>[0]>).map(
    (plan) => presentMembershipPlan(plan, platform),
  );
}

export async function createMembershipOrder(input: {
  customerId: string;
  planCode: string;
  platform: string;
  idempotencyKey: string;
  agreementVersions: Record<string, string>;
}) {
  const channel =
    input.platform === "ios"
      ? "apple"
      : input.platform === "wechat_mini_program" || input.platform === "android"
        ? "wechat"
        : null;
  if (!channel) throw new Error("Invalid membership platform");

  const { data: planData, error: planError } = await supabaseAdmin
    .from("commerce_membership_plans" as never)
    .select("id,code,amount_fen")
    .eq("code", input.planCode)
    .eq("is_active", true)
    .single();
  if (planError || !planData) fail(planError, "Membership plan unavailable");
  const plan = planData as unknown as { id: string; code: string; amount_fen: number };

  const payload = {
    customer_id: input.customerId,
    plan_id: plan.id,
    platform: channel,
    amount_fen: plan.amount_fen,
    idempotency_key: input.idempotencyKey,
    agreement_versions: input.agreementVersions,
  };
  const { data, error } = await supabaseAdmin
    .from("commerce_membership_orders" as never)
    .insert(payload as never)
    .select("id,status,amount_fen")
    .single();
  if (error || !data) {
    const { data: existing, error: existingError } = await supabaseAdmin
      .from("commerce_membership_orders" as never)
      .select("id,status,amount_fen")
      .eq("customer_id", input.customerId)
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (existingError || !existing) fail(error ?? existingError, "Membership order unavailable");
    return {
      ...(existing as unknown as Record<string, unknown>),
      plan_code: plan.code,
      platform: input.platform,
    };
  }
  return {
    ...(data as unknown as Record<string, unknown>),
    plan_code: plan.code,
    platform: input.platform,
  };
}

export async function reserveRecognitionQuota(customerId: string, requestId: string) {
  const { data, error } = await supabaseAdmin.rpc(
    "commerce_reserve_recognition_quota" as never,
    { p_customer_id: customerId, p_request_id: requestId } as never,
  );
  if (error) fail(error, "Recognition quota unavailable");
  const quota = data as unknown as {
    allowance: number;
    used: number;
    remaining: number;
    duplicate: boolean;
  };
  return {
    used: quota.used,
    daily_limit: quota.allowance,
    remaining: quota.remaining,
    duplicate: quota.duplicate,
  };
}

export async function listMembershipCoupons(customerId: string) {
  const { data, error } = await supabaseAdmin
    .from("pos_customer_coupons" as never)
    .select("id,code,name,value,min_spend,status,created_at,expires_at,metadata")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false });
  if (error) fail(error, "Membership coupons unavailable");
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => ({
    id: row.id,
    code: row.code,
    title: row.name,
    face_value_fen: Math.round(Number(row.value) * 100),
    threshold_fen: Math.round(Number(row.min_spend) * 100),
    issued_at: row.created_at,
    expires_at: row.expires_at,
    used_at:
      row.status === "used"
        ? ((row.metadata as Record<string, unknown> | null)?.used_at ?? row.created_at)
        : null,
  }));
}

export async function listMembershipPointsLedger(customerId: string) {
  const { data, error } = await supabaseAdmin
    .from("commerce_points_ledger" as never)
    .select("id,delta,source_type,source_id,balance_after,created_at")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) fail(error, "Points ledger unavailable");
  return data ?? [];
}

export async function listMembershipConsumptionRecords(customerId: string) {
  const { data, error } = await supabaseAdmin
    .from("commerce_consumption_records" as never)
    .select(
      "id,channel,location_id,gross_amount_fen,discount_amount_fen,points_discount_fen,paid_amount_fen,benefit_snapshot,occurred_at",
    )
    .eq("customer_id", customerId)
    .order("occurred_at", { ascending: false })
    .limit(200);
  if (error) fail(error, "Consumption records unavailable");
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => ({
    id: row.id,
    store_name:
      (row.benefit_snapshot as Record<string, unknown> | null)?.store_name ?? "BOOMER-OFF",
    subtotal_fen: row.gross_amount_fen,
    promotion_discount_fen: row.discount_amount_fen,
    points_discount_fen: row.points_discount_fen,
    paid_fen: row.paid_amount_fen,
    promotion_label:
      (row.benefit_snapshot as Record<string, unknown> | null)?.promotion_label ?? null,
    created_at: row.occurred_at,
  }));
}

export async function createMembershipCode(customerId: string) {
  const token = randomBytes(24).toString("base64url");
  const value = `boomer-off:member:${token}`;
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("commerce_member_code_sessions" as never)
    .insert({
      customer_id: customerId,
      code_hash: createHash("sha256").update(value).digest("hex"),
      expires_at: expiresAt,
    } as never)
    .select("id")
    .single();
  if (error || !data) fail(error, "Member code unavailable");
  return { id: (data as unknown as { id: string }).id, value, expires_at: expiresAt };
}
