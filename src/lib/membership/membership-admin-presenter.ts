export type MembershipAdminCustomer = {
  id: string;
  external_subject: string;
  phone: string | null;
  nickname: string | null;
  avatar_url: string | null;
  status: string;
  created_at: string;
};

export type MembershipAdminEntitlement = {
  tier_code: "free" | "explorer";
  status: string;
  starts_at: string;
  expires_at: string | null;
  auto_renew: boolean;
  source: string;
  plan: { code: string; display_name: string } | null;
};

export type MembershipAdminRowInput = {
  customer: MembershipAdminCustomer;
  entitlement: MembershipAdminEntitlement | null;
  usage: { used: number; allowance: number } | null;
  points: number;
  couponCount: number;
  spend90dFen: number;
};

export type MembershipAdminExpiryState = "free" | "active" | "expiring" | "expired";

export function maskMembershipPhone(phone: string | null) {
  if (!phone) return "未绑定手机";
  if (/^1\d{10}$/.test(phone)) return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
  if (phone.length <= 5) return phone;
  return `${phone.slice(0, 2)}***${phone.slice(-2)}`;
}

function memberNumber(id: string) {
  return `BO${id.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

function expiryState(
  entitlement: MembershipAdminEntitlement | null,
  now: Date,
): MembershipAdminExpiryState {
  if (!entitlement || entitlement.tier_code === "free") return "free";
  if (entitlement.status !== "active") return "expired";
  if (!entitlement.expires_at) return "active";
  const remaining = new Date(entitlement.expires_at).getTime() - now.getTime();
  if (remaining <= 0) return "expired";
  return remaining <= 7 * 24 * 60 * 60 * 1000 ? "expiring" : "active";
}

export function presentMembershipAdminRow(input: MembershipAdminRowInput, now = new Date()) {
  const tierCode = input.entitlement?.tier_code === "explorer" ? "explorer" : "free";
  const allowance = input.usage?.allowance ?? (tierCode === "explorer" ? 30 : 5);
  const used = Math.min(input.usage?.used ?? 0, allowance);

  return {
    id: input.customer.id,
    member_no: memberNumber(input.customer.id),
    phone: input.customer.phone,
    masked_phone: maskMembershipPhone(input.customer.phone),
    nickname: input.customer.nickname,
    avatar_url: input.customer.avatar_url,
    customer_status: input.customer.status,
    tier_code: tierCode,
    tier_name: tierCode === "explorer" ? "探索会员" : "好奇玩家",
    plan_code: input.entitlement?.plan?.code ?? null,
    plan_name: input.entitlement?.plan?.display_name ?? null,
    entitlement_status: input.entitlement?.status ?? null,
    expiry_state: expiryState(input.entitlement, now),
    expires_at: input.entitlement?.expires_at ?? null,
    auto_renew: input.entitlement?.auto_renew ?? false,
    source: input.entitlement?.source ?? null,
    recognition: { used, allowance, remaining: Math.max(allowance - used, 0) },
    points: input.points,
    coupon_count: input.couponCount,
    spend_90d_fen: input.spend90dFen,
    created_at: input.customer.created_at,
  };
}
