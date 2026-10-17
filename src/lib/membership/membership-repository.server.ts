import { mapMembershipCoupon } from "@/lib/membership/coupon-status";
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
      // 积分只读有赞权威投影；本地自主钱包（含历史测试积分）不再参与顾客展示。
      loadYouzanAccountPoints(customerId),
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
  if (usageResult.error) fail(usageResult.error, "Recognition usage unavailable");
  if (couponResult.error) fail(couponResult.error, "Membership coupons unavailable");

  const entitlement = entitlementResult.data as unknown as {
    expires_at: string | null;
    auto_renew: boolean;
    source: string;
    plan: Record<string, unknown> | null;
  } | null;
  const freePlan = freePlanResult.data as unknown as Record<string, unknown>;
  const usage = usageResult.data as unknown as { used: number; allowance: number } | null;

  return presentMembershipAccount({
    plan: (entitlement?.plan ?? freePlan) as never,
    entitlement,
    usage,
    pointsBalance: walletResult.balance,
    points: (await import("@/server/youzan-points-projection.server")).toPointsContract(walletResult),
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
    .select("id,code,name,value,min_spend,status,starts_at,created_at,expires_at,metadata,external_provider")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false });
  if (error) fail(error, "Membership coupons unavailable");
  const now = Date.now();
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => mapMembershipCoupon(row, now));
}

const POINTS_SYNC_BUDGET_MS = 5000;

/** 打开账户时同步有赞余额（有界等待）；超时/失败返回已存投影与真实状态，绝不回退本地或 0。 */
export async function loadYouzanAccountPoints(
  customerId: string,
  shared?: Awaited<ReturnType<typeof import("@/server/youzan-points-projection-production.server").productionPointsProjection>>,
) {
  const { productionPointsProjection, withBudget } = await import("@/server/youzan-points-projection-production.server");
  let projection = shared;
  if (!projection) try { projection = await productionPointsProjection(); } catch {
    return { source: "youzan" as const, balance: null, status: "failed" as const, synced_at: null, reason: "points_projection_unavailable" };
  }
  const synced = await withBudget(projection.accountPoints(customerId, { sync: true }), POINTS_SYNC_BUDGET_MS);
  if (synced !== "timeout") return synced;
  const stored = await projection.accountPoints(customerId, { sync: false });
  return stored.status === "ok" ? { ...stored, status: "pending" as const, reason: "youzan_sync_in_progress" } : stored;
}

/** 积分记录：只返回有赞官方日志镜像；分页 cursor；状态与余额独立。 */
export async function listMembershipPointsLedger(customerId: string, opts: { cursor?: string | null; limit?: number } = {}) {
  const { productionPointsProjection, withBudget } = await import("@/server/youzan-points-projection-production.server");
  const projection = await productionPointsProjection();
  const { toLedgerSync, toLegacyLedgerRows } = await import("@/server/youzan-points-projection.server");
  const sync = !opts.cursor;
  const [ledger, balance] = await Promise.all([
    withBudget(projection.ledger(customerId, { sync, ...opts }), POINTS_SYNC_BUDGET_MS),
    loadYouzanAccountPoints(customerId, projection),
  ]);
  let view = ledger;
  if (view === "timeout") {
    const stored = await projection.ledger(customerId, { sync: false, ...opts });
    view = stored.status === "ok" ? { ...stored, status: "pending" as const, reason: "youzan_sync_in_progress" } : stored;
  }
  return { rows: toLegacyLedgerRows(view.items), points_sync: toLedgerSync(view, balance) };
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
