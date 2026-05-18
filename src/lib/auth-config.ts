// 超级管理员手机号（写死，简单可靠）
export const SUPER_ADMIN_PHONES = ["18657433310"] as const;

export function isSuperAdminPhone(phone?: string | null): boolean {
  if (!phone) return false;
  return SUPER_ADMIN_PHONES.includes(phone as (typeof SUPER_ADMIN_PHONES)[number]);
}

export const PHONE_REGEX = /^1[3-9]\d{9}$/;
