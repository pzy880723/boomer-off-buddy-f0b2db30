// 手机首页尺寸待办：鉴权门禁 + 本店未完成任务读取（可注入查询，便于行为测试）。
export type GateResult = { ok: true } | { ok: false; status: 401 | 403; code: "session_required" | "location_forbidden" };

export async function dashboardGate(
  session: { user_id: string } | null,
  canAccess: (userId: string) => Promise<boolean>,
): Promise<GateResult> {
  if (session && !(await canAccess(session.user_id))) return { ok: false, status: 403, code: "location_forbidden" };
  return { ok: true };
}

export type MeasureRow = { id: string; sku_id: string; status: string; created_at: string; sku: { name: string } | null };
export type MeasureQuery = (locationId: string) => PromiseLike<{ data: MeasureRow[] | null; error: { message: string } | null }>;

export async function loadMeasurementTasks(query: MeasureQuery, locationId: string) {
  const { data } = await query(locationId);
  return { status: "ok" as const, rows: data ?? [] };
}
