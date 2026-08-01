export type StorePaymentProfile = {
  id: string;
  locationId: string;
  locationName: string;
  paymentCode: string;
  profileStatus: "setup_required" | "pending" | "active" | "disabled";
  subjectId: string;
  subjectName: string;
  verificationStatus: "draft" | "pending" | "approved" | "rejected";
  providerStatus: "not_applied" | "applying" | "active" | "rejected" | "suspended";
  merchantId: string | null;
};

type PaymentItem = {
  id: string;
  locationId: string;
  lineTotal: number;
};

type PaymentPlanInput = {
  orderId: string;
  totalAmount: number;
  currency: string;
  items: PaymentItem[];
  profiles: StorePaymentProfile[];
};

export class StorePaymentNotReadyError extends Error {
  readonly code = "store_payment_not_ready";

  constructor(readonly locationIds: string[]) {
    super(`Store payment is not ready for location(s): ${locationIds.join(", ")}`);
    this.name = "StorePaymentNotReadyError";
  }
}

function toMinor(amount: number) {
  if (!Number.isFinite(amount)) throw new Error("Payment amount must be finite");
  return Math.round(amount * 100);
}

function fromMinor(amount: number) {
  return Number((amount / 100).toFixed(2));
}

function allocateAdjustment(adjustment: number, weights: number[]) {
  if (weights.length === 0) return [];
  if (adjustment === 0) return weights.map(() => 0);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const fallbackWeight = totalWeight > 0 ? null : 1;
  const denominator = totalWeight > 0 ? totalWeight : weights.length;
  const sign = Math.sign(adjustment);
  const absolute = Math.abs(adjustment);
  const allocations = weights.map((weight, index) => {
    const raw = (absolute * (fallbackWeight ?? weight)) / denominator;
    return { index, value: Math.floor(raw), remainder: raw - Math.floor(raw) };
  });
  let remainder = absolute - allocations.reduce((sum, entry) => sum + entry.value, 0);
  for (const entry of [...allocations].sort((left, right) => {
    if (right.remainder !== left.remainder) return right.remainder - left.remainder;
    return left.index - right.index;
  })) {
    if (remainder <= 0) break;
    allocations[entry.index].value += 1;
    remainder -= 1;
  }
  return allocations.map((entry) => entry.value * sign);
}

export function buildStorePaymentPlan(input: PaymentPlanInput) {
  if (input.items.length === 0) throw new Error("Payment plan requires at least one item");
  const profileByLocation = new Map(input.profiles.map((profile) => [profile.locationId, profile]));
  const missing = [...new Set(input.items.map((item) => item.locationId))].filter((locationId) => {
    const profile = profileByLocation.get(locationId);
    return (
      !profile ||
      profile.profileStatus !== "active" ||
      profile.verificationStatus !== "approved" ||
      profile.providerStatus !== "active" ||
      !profile.merchantId
    );
  });
  if (missing.length > 0) throw new StorePaymentNotReadyError(missing);

  const groups = new Map<
    string,
    {
      profile: StorePaymentProfile;
      lineMinor: number;
      locationIds: Set<string>;
    }
  >();
  const itemSnapshots = input.items.map((item) => {
    const profile = profileByLocation.get(item.locationId)!;
    const group = groups.get(profile.id) ?? {
      profile,
      lineMinor: 0,
      locationIds: new Set<string>(),
    };
    group.lineMinor += toMinor(item.lineTotal);
    group.locationIds.add(item.locationId);
    groups.set(profile.id, group);
    return {
      orderItemId: item.id,
      settlementSubjectId: profile.subjectId,
      snapshot: {
        order_id: input.orderId,
        location_id: item.locationId,
        location_name: profile.locationName,
        payment_profile_id: profile.id,
        payment_code: profile.paymentCode,
        settlement_subject_id: profile.subjectId,
        settlement_subject_name: profile.subjectName,
        merchant_id: profile.merchantId,
        line_amount: fromMinor(toMinor(item.lineTotal)),
        currency: input.currency,
      },
    };
  });

  const grouped = [...groups.values()];
  const totalLineMinor = grouped.reduce((sum, entry) => sum + entry.lineMinor, 0);
  const totalMinor = toMinor(input.totalAmount);
  if (totalMinor <= 0) throw new Error("Payment total must be positive");
  const adjustments = allocateAdjustment(
    totalMinor - totalLineMinor,
    grouped.map((entry) => entry.lineMinor),
  );
  const subOrders = grouped.map((entry, index) => ({
    paymentProfileId: entry.profile.id,
    settlementSubjectId: entry.profile.subjectId,
    merchantId: entry.profile.merchantId!,
    paymentCode: entry.profile.paymentCode,
    amount: fromMinor(entry.lineMinor + adjustments[index]),
    lineAmount: fromMinor(entry.lineMinor),
    orderAdjustment: fromMinor(adjustments[index]),
    locationIds: [...entry.locationIds],
  }));
  if (subOrders.some((entry) => entry.amount < 0)) {
    throw new Error("Order-level discount exceeds a store's allocated amount");
  }
  return { subOrders, itemSnapshots };
}
