import * as z from "zod";

/** 未读角标契约：五项均为有限非负安全整数，total = 四类之和。 */
export const UNREAD_COUNT_KEYS = ["customers", "internal", "orders", "system", "total"] as const;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const UnreadCountsData = z.object({
  customers: count,
  internal: count,
  orders: count,
  system: count,
  total: count,
});
export type UnreadCounts = z.infer<typeof UnreadCountsData>;

/**
 * 严格解析 RPC 结果：缺字段、非数字、负数、小数、溢出或 total 不等于四类之和
 * 均返回 ok:false（调用方应 500 contract error），绝不零化。
 */
export function parseUnreadCounts(raw: unknown): { ok: true; data: UnreadCounts } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not_object" };
  const r = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of UNREAD_COUNT_KEYS) {
    const v = r[k];
    const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return { ok: false, reason: `invalid_${k}` };
    out[k] = n;
  }
  if (out.customers + out.internal + out.orders + out.system !== out.total) return { ok: false, reason: "total_mismatch" };
  return { ok: true, data: out as UnreadCounts };
}
