// 会员券列表映射：只有 active 且已开始、未过期才可用；其他（已用/过期/作废/冻结/未知）一律不可用，历史保留展示。
export type MembershipCouponStatus = "available" | "not_started" | "used" | "expired" | "void" | "frozen";

const iso = (v: unknown) => (typeof v === "string" && v ? Date.parse(v) : NaN);

export function couponStatus(row: Record<string, unknown>, now = Date.now()): MembershipCouponStatus {
  const status = String(row.status ?? "");
  if (status === "used") return "used";
  if (status === "void" || status === "cancelled") return "void";
  if (status === "reserved" || status === "frozen") return "frozen";
  if (status === "expired") return "expired";
  if (status !== "active") return "void"; // 未知状态 fail-closed
  const exp = iso(row.expires_at);
  if (!Number.isNaN(exp) && exp <= now) return "expired";
  const start = iso(row.starts_at);
  if (!Number.isNaN(start) && start > now) return "not_started";
  return "available";
}

export function mapMembershipCoupon(row: Record<string, unknown>, now = Date.now()) {
  const status = couponStatus(row, now);
  const meta = (row.metadata as Record<string, unknown> | null) ?? {};
  return {
    id: row.id,
    code: row.code,
    title: row.name,
    face_value_fen: Math.round(Number(row.value) * 100),
    threshold_fen: Math.round(Number(row.min_spend) * 100),
    issued_at: row.created_at,
    starts_at: row.starts_at ?? null,
    expires_at: row.expires_at,
    status,
    usable: status === "available",
    source: row.external_provider === "youzan" ? "youzan" : "erp",
    used_at: status === "used" ? (meta.used_at ?? null) : null,
  } as Record<string, unknown>;
}
