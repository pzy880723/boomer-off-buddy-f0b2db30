export type MembershipTier = "free" | "explorer";

export type MembershipPolicy = {
  tier: MembershipTier;
  version: number;
  dailyRecognitionLimit: number;
  officialDiscountRate: number;
  pointsMultiplier: number;
  pointsRedemptionCapRate: number;
};

const POLICIES: Record<MembershipTier, MembershipPolicy> = {
  free: {
    tier: "free",
    version: 1,
    dailyRecognitionLimit: 5,
    officialDiscountRate: 1,
    pointsMultiplier: 1,
    pointsRedemptionCapRate: 0,
  },
  explorer: {
    tier: "explorer",
    version: 1,
    dailyRecognitionLimit: 30,
    officialDiscountRate: 0.95,
    pointsMultiplier: 1.2,
    pointsRedemptionCapRate: 0.15,
  },
};

export function membershipPolicyForTier(tier: MembershipTier): MembershipPolicy {
  return POLICIES[tier];
}

export function pointsDiscountLimitFen(subtotalFen: number, tier: MembershipTier): number {
  const subtotal = Math.max(0, Math.floor(subtotalFen));
  return Math.floor(subtotal * membershipPolicyForTier(tier).pointsRedemptionCapRate);
}

export function chooseBestBenefit(input: {
  subtotalFen: number;
  tier: MembershipTier;
  couponSavingFen: number;
}): { kind: "coupon" | "member_discount" | "none"; savingFen: number } {
  const subtotal = Math.max(0, Math.floor(input.subtotalFen));
  const couponSaving = Math.min(subtotal, Math.max(0, Math.floor(input.couponSavingFen)));
  const memberSaving = Math.floor(
    subtotal * (1 - membershipPolicyForTier(input.tier).officialDiscountRate),
  );

  if (couponSaving <= 0 && memberSaving <= 0) return { kind: "none", savingFen: 0 };
  if (couponSaving > memberSaving) return { kind: "coupon", savingFen: couponSaving };
  return { kind: "member_discount", savingFen: memberSaving };
}
