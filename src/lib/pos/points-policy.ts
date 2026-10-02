export type PointsRules = {
  enabled: boolean;
  customer_active: boolean;
  available_points: number;
  cap_rate: number;
  points_per_unit: number | null;
  unit_fen: number | null;
  policy_version: number | null;
};

function decimalRatio(value: number): [bigint, bigint] {
  if (!Number.isFinite(value) || value < 0 || value >= 10_000_000_000) {
    throw new Error("money_amount_invalid");
  }
  const [mantissa, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const scale = fraction.length - Number(exponent);
  const numerator = BigInt(whole + fraction);
  return scale >= 0 ? [numerator, 10n ** BigInt(scale)] : [numerator * 10n ** BigInt(-scale), 1n];
}

function roundRatio(numerator: bigint, denominator: bigint): number {
  if (numerator < 0n) throw new Error("discount exceeds eligible amount");
  const result = Number((2n * numerator + denominator) / (2n * denominator));
  if (!Number.isSafeInteger(result)) throw new Error("money_amount_invalid");
  return result;
}

/** Decimal rounding matches PostgreSQL numeric, including half-fen boundaries. */
export function moneyFen(value: number): number {
  const [numerator, denominator] = decimalRatio(value);
  return roundRatio(numerator * 100n, denominator);
}

export function calculatePointsDiscountTotals(
  lines: Array<{ quantity: number; unit_price: number; discount_eligible: boolean }>,
  discount: { type: "amount" | "percentage" | "final_price"; value: number },
) {
  if (!lines.length) throw new Error("sale requires items");
  let subtotal = 0;
  let eligible = 0;
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 999) throw new Error("quantity invalid");
    const amount = moneyFen(line.unit_price) * line.quantity;
    subtotal += amount;
    if (line.discount_eligible) eligible += amount;
  }
  if (subtotal >= 1_000_000_000_000) throw new Error("money_amount_invalid");
  const [value, denominator] = decimalRatio(discount.value);
  let saving: number;
  if (discount.type === "amount") saving = moneyFen(discount.value);
  else if (discount.type === "percentage") {
    if (discount.value > 100) throw new Error("percentage discount invalid");
    saving = roundRatio(BigInt(eligible) * (100n * denominator - value), 100n * denominator);
  } else saving = roundRatio(BigInt(subtotal) * denominator - value * 100n, denominator);
  if (saving > eligible) throw new Error("discount exceeds eligible amount");
  return { subtotal: subtotal / 100, eligible_total: eligible / 100,
    excluded_total: (subtotal - eligible) / 100, discount_total: saving / 100, payable_total: (subtotal - saving) / 100 };
}

export function calculatePointsRedemption(
  totals: { subtotal: number; eligible_total: number; discount_total: number; payable_total: number },
  requested: number,
  rules: PointsRules | null,
) {
  if (!Number.isInteger(requested) || requested < 0 || requested > 2147483647) {
    throw new Error("points_request_invalid");
  }
  const eligibleFen = moneyFen(totals.eligible_total);
  const remainderFen = Math.max(0, eligibleFen - moneyFen(totals.discount_total));
  const payableFen = moneyFen(totals.payable_total);
  moneyFen(totals.subtotal);
  const available = rules && Number.isInteger(rules.available_points) && rules.available_points >= 0
    ? rules.available_points : 0;
  const validUnit = (value: number | null | undefined) =>
    value != null && Number.isInteger(value) && value > 0 && value <= 2147483647;
  const configured = rules?.enabled === true && validUnit(rules.points_per_unit) && validUnit(rules.unit_fen);
  const cap = rules?.cap_rate ?? 0;
  const enabled = configured && rules!.customer_active && Number.isFinite(cap) && cap > 0 && cap <= 1;
  // Membership caps have four decimal places. Floor the cap before whole-unit conversion.
  const capFen = enabled
    ? Number(BigInt(remainderFen) * BigInt(Math.round(cap * 10000)) / 10000n) : 0;
  const maxPoints = enabled ? Math.min(
    Math.floor(Math.min(capFen, Math.max(0, payableFen - 1)) / rules!.unit_fen!),
    Math.floor(available / rules!.points_per_unit!),
  ) * rules!.points_per_unit! : 0;
  const applied = enabled ? Math.floor(Math.min(requested, maxPoints) / rules!.points_per_unit!) * rules!.points_per_unit! : 0;
  return {
    enabled, available_points: available, max_points: maxPoints, requested_points: requested,
    applied_points: applied,
    discount_amount: enabled ? applied / rules!.points_per_unit! * rules!.unit_fen! / 100 : 0,
    reason: !configured ? "points_rule_not_configured"
      : !rules!.customer_active ? "customer_inactive"
      : !enabled ? "membership_points_not_allowed"
      : maxPoints === 0 ? "points_unavailable"
      : applied !== requested ? "points_request_capped" : null,
    cap_rate: cap, points_per_unit: rules?.points_per_unit ?? null,
    unit_fen: rules?.unit_fen ?? null, policy_version: rules?.policy_version ?? null,
    supported_tenders: ["cash"], async_payment_supported: false,
    cap_basis: "eligible_after_discount", minimum_payable_fen: 1,
  };
}
