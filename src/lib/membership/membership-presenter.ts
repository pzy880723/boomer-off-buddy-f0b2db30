type PlanRow = {
  id?: string;
  code?: string;
  tier_code: "free" | "explorer";
  billing_period?: "free" | "monthly" | "annual";
  amount_fen?: number;
  renewal_amount_fen?: number | null;
  daily_recognition_limit: number;
  official_discount_rate: number;
  points_multiplier: number;
  points_redemption_cap_rate: number;
  policy_version?: number;
};

type EntitlementRow = {
  expires_at: string | null;
  auto_renew: boolean;
  source: string;
};

const FREE_PLAN: PlanRow = {
  tier_code: "free",
  daily_recognition_limit: 5,
  official_discount_rate: 1,
  points_multiplier: 1,
  points_redemption_cap_rate: 0,
  policy_version: 1,
};

function appPlatform(source: string | undefined): string | null {
  if (!source) return null;
  if (source === "apple") return "ios";
  if (source === "wechat") return "wechat_mini_program";
  return source;
}

function benefits(plan: PlanRow) {
  return {
    recognition_daily_limit: plan.daily_recognition_limit,
    official_discount_rate: plan.official_discount_rate < 1 ? plan.official_discount_rate : null,
    points_multiplier: plan.points_multiplier,
    points_order_cap_rate: plan.points_redemption_cap_rate,
    can_sell: false,
  };
}

export function presentMembershipAccount(input: {
  plan?: PlanRow | null;
  entitlement?: EntitlementRow | null;
  usage?: { used: number; allowance: number } | null;
  pointsBalance: number;
  couponCount: number;
}) {
  const plan = input.plan ?? FREE_PLAN;
  const isPaid = plan.tier_code === "explorer";
  const allowance = input.usage?.allowance ?? plan.daily_recognition_limit;
  const used = input.usage?.used ?? 0;
  return {
    tier: {
      code: isPaid ? "explorer" : "curious_player",
      name: isPaid ? "探索会员" : "好奇玩家",
      is_paid: isPaid,
      benefits: benefits(plan),
    },
    recognition: {
      used,
      daily_limit: allowance,
      remaining: Math.max(0, allowance - used),
    },
    points: { balance: input.pointsBalance },
    coupon_count: input.couponCount,
    can_sell: false,
    expires_at: input.entitlement?.expires_at ?? null,
    auto_renew: input.entitlement?.auto_renew ?? false,
    platform: appPlatform(input.entitlement?.source),
    policy_version: plan.policy_version ?? 1,
  };
}

export function presentMembershipPlan(
  plan: Required<
    Pick<
      PlanRow,
      | "id"
      | "code"
      | "tier_code"
      | "billing_period"
      | "amount_fen"
      | "daily_recognition_limit"
      | "official_discount_rate"
      | "points_multiplier"
      | "points_redemption_cap_rate"
    >
  > &
    Pick<PlanRow, "renewal_amount_fen">,
  platform: string,
) {
  const monthlyAverage =
    plan.billing_period === "annual" ? Math.floor(plan.amount_fen / 12) : plan.amount_fen;
  const annualMonthlyCost = 990 + 11 * 1990;
  return {
    id: plan.id,
    code: plan.code,
    tier_code: plan.tier_code,
    platform,
    billing_period: plan.billing_period,
    price_fen: plan.amount_fen,
    renewal_price_fen: plan.renewal_amount_fen ?? null,
    savings_fen:
      plan.billing_period === "annual" ? Math.max(0, annualMonthlyCost - plan.amount_fen) : 0,
    monthly_average_fen: monthlyAverage,
    benefits: benefits(plan),
  };
}
