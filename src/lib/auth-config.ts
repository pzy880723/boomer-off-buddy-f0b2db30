// 超级管理员手机号（写死，简单可靠）
export const SUPER_ADMIN_PHONES = ["18657433310"] as const;

export function isSuperAdminPhone(phone?: string | null): boolean {
  if (!phone) return false;
  return SUPER_ADMIN_PHONES.includes(phone as (typeof SUPER_ADMIN_PHONES)[number]);
}

export const PHONE_REGEX = /^1[3-9]\d{9}$/;

// 内部用伪邮箱：手机号 ↔ {phone}@users.local
// 目的：绕开 Supabase Phone Provider 开关，统一走 email+password
export const FAKE_EMAIL_DOMAIN = "users.local";

export function phoneToEmail(phone: string): string {
  return `${phone}@${FAKE_EMAIL_DOMAIN}`;
}

export function emailToPhone(email?: string | null): string | null {
  if (!email) return null;
  const suffix = `@${FAKE_EMAIL_DOMAIN}`;
  return email.endsWith(suffix) ? email.slice(0, -suffix.length) : null;
}

/** 从 Supabase user 对象推断显示用手机号（兼容旧 phone 字段） */
export function resolveUserPhone(user?: {
  phone?: string | null;
  email?: string | null;
  user_metadata?: { phone?: string | null } | null;
} | null): string | null {
  if (!user) return null;
  return (
    emailToPhone(user.email) ||
    user.phone ||
    user.user_metadata?.phone ||
    null
  );
}
