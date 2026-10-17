// 手机首页尺寸待办：鉴权门禁 + 本店未完成任务读取（可注入查询，便于行为测试）。
export type GateResult = { ok: true } | { ok: false; status: 401 | 403; code: "session_required" | "location_forbidden" };

/** 首页含顾客测量任务：必须员工会话（缺失 401），且门店在授权范围（否则 403）。 */
export async function dashboardGate(
  session: { user_id: string } | null,
  canAccess: (userId: string) => Promise<boolean>,
): Promise<GateResult> {
  if (!session) return { ok: false, status: 401, code: "session_required" };
  if (!(await canAccess(session.user_id))) return { ok: false, status: 403, code: "location_forbidden" };
  return { ok: true };
}

/** 未完成任务状态；真实查询与 mock 行为测试共用同一规则。 */
export const MEASUREMENT_OPEN_STATUSES = ["pending", "claimed"] as const;
export function measurementFilter(row: { location_id: string; status: string }, locationId: string): boolean {
  return row.location_id === locationId && (MEASUREMENT_OPEN_STATUSES as readonly string[]).includes(row.status);
}

export type MeasureRow = { id: string; sku_id: string; status: string; created_at: string; sku: { name: string } | null };
export type MeasureQuery = (locationId: string) => PromiseLike<{ data: MeasureRow[] | null; error: { message: string } | null }>;

/** 读取失败返回 unavailable（不冒称"暂无待办"）；成功按创建时间升序。 */
export async function loadMeasurementTasks(
  query: MeasureQuery,
  locationId: string,
): Promise<{ status: "ok" | "unavailable"; rows: MeasureRow[] }> {
  try {
    const { data, error } = await query(locationId);
    if (error || !data) return { status: "unavailable", rows: [] };
    return { status: "ok", rows: [...data].sort((a, b) => a.created_at.localeCompare(b.created_at)) };
  } catch {
    return { status: "unavailable", rows: [] };
  }
}
