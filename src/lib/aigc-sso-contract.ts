const AIGC_ALLOWED_ROLES = new Set(["super_admin", "hq_operator", "store_manager", "store_staff"]);

const AIGC_ACCESS_PERMISSION = "aigc_access";
const SSO_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hasAigcAccess(roles: string[], permissions: string[]): boolean {
  return (
    permissions.includes(AIGC_ACCESS_PERMISSION) ||
    roles.some((role) => AIGC_ALLOWED_ROLES.has(role))
  );
}

export function isActiveBan(bannedUntil: string | null | undefined, now = Date.now()): boolean {
  if (!bannedUntil) return false;
  const timestamp = Date.parse(bannedUntil);
  return Number.isFinite(timestamp) && timestamp > now;
}

export function isValidSsoTicket(ticket: string): boolean {
  return SSO_TICKET_PATTERN.test(ticket);
}

export function buildAigcRedirectUrl(baseUrl: string, ticket: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return `${normalizedBase}/auth/erp?ticket=${encodeURIComponent(ticket)}`;
}
