export type EditorialContentRole =
  "super_admin" | "hq_operator" | "store_manager" | "store_staff" | "warehouse_staff";

export function canManageEditorialContent(roles: readonly EditorialContentRole[]) {
  return roles.includes("super_admin") || roles.includes("hq_operator");
}
