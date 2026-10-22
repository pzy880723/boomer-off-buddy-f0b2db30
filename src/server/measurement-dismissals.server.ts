// 测量任务「个人忽略」核心逻辑：只对当前员工 + 当前门店生效，不改业务任务状态。
// 任务归属/状态/版本一致性由 DB 函数 measurement_task_dismiss / measurement_task_undismiss
// 在单次调用内原子校验；这里负责输入合同、门店授权（session 员工，绝不信任 body user_id）
// 与错误码映射。路由：src/routes/api/public/handheld/work-items.measurement-dismissals.ts
import { z } from "zod";

export const dismissalInput = z
  .object({
    location_id: z.string().uuid(),
    task_id: z.string().uuid(),
    request_version: z.string().min(1).max(120),
  })
  .strict();

export type DismissalRpc = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;

export type DismissalScope = { user_id: string; location_ids: string[] };

export type DismissalResult =
  | { ok: true; data: { dismissed: boolean; task_id: string; request_version: string } }
  | { ok: false; status: number; code: string; message: string; current_version?: string };

function mapRpcError(error: { message: string; code?: string }): DismissalResult {
  if (error.code === "P0002" || error.message.includes("task_not_found")) {
    return { ok: false, status: 404, code: "task_not_found", message: "Measurement task not found" };
  }
  if (error.code === "P0003" || error.message.includes("task_location_mismatch")) {
    return { ok: false, status: 403, code: "task_location_mismatch", message: "Task belongs to another store" };
  }
  if (error.code === "P0009" || error.message.includes("task_closed")) {
    return { ok: false, status: 409, code: "task_closed", message: "Task already completed or cancelled" };
  }
  if (error.code === "P0010" || error.message.includes("stale_request_version")) {
    const current = error.message.split("stale_request_version:")[1]?.trim();
    return {
      ok: false,
      status: 409,
      code: "stale_request_version",
      message: "Request version changed; refresh and retry",
      ...(current ? { current_version: current } : {}),
    };
  }
  return { ok: false, status: 500, code: "dismissal_failed", message: "Dismissal temporarily unavailable" };
}

/**
 * mode=dismiss 忽略 / undismiss 撤销。门店授权在调用 DB 前完成：location_id 必须在
 * 员工授权门店集合内，外店请求零 DB 写。task 真实门店与请求版本由 DB 函数复核。
 */
export async function applyMeasurementDismissal(
  deps: { rpc: DismissalRpc },
  scope: DismissalScope,
  rawBody: unknown,
  mode: "dismiss" | "undismiss",
): Promise<DismissalResult> {
  const parsed = dismissalInput.safeParse(rawBody);
  if (!parsed.success) {
    return { ok: false, status: 400, code: "validation_error", message: "Invalid body" };
  }
  const body = parsed.data;
  if (!scope.location_ids.includes(body.location_id)) {
    return { ok: false, status: 403, code: "location_forbidden", message: "Location not authorized for this account" };
  }
  const { data, error } = await deps.rpc(
    mode === "dismiss" ? "measurement_task_dismiss" : "measurement_task_undismiss",
    {
      p_task_id: body.task_id,
      p_user_id: scope.user_id,
      p_location_id: body.location_id,
      p_request_version: body.request_version,
    },
  );
  if (error) return mapRpcError(error);
  // 严格校验 RPC 结果：task_id 回显一致、dismissed 为布尔、request_version 为字符串；
  // 缺失或变形一律 500，绝不用请求参数 fallback 伪成功。
  const row = data as { dismissed?: unknown; task_id?: unknown; request_version?: unknown } | null;
  if (
    !row ||
    typeof row !== "object" ||
    row.task_id !== body.task_id ||
    typeof row.dismissed !== "boolean" ||
    typeof row.request_version !== "string" ||
    row.request_version.length === 0
  ) {
    return { ok: false, status: 500, code: "dismissal_failed", message: "Dismissal temporarily unavailable" };
  }
  return {
    ok: true,
    data: {
      dismissed: row.dismissed,
      task_id: row.task_id,
      request_version: row.request_version,
    },
  };
}
