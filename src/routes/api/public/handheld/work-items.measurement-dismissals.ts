import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { resolveWorkScope } from "@/server/handheld-work-items.server";
import {
  applyMeasurementDismissal,
  authorizeMeasurementTaskLocation,
  dismissalInput,
} from "@/server/measurement-dismissals.server";

// 测量任务「个人忽略」：POST 忽略 / DELETE 撤销，body 均为
// { location_id, task_id, request_version }。员工身份只取 session，绝不信任 body user_id；
// 授权按任务真实所属 scope：带有效客服卡的任务可按已授权 support scope（或 general scope），
// 孤立任务必须 general scope——两个门店数组独立判断，绝不混并扩大业务访问；
// 任务归属/状态/版本由 DB 函数原子复核。
async function handle(request: Request, mode: "dismiss" | "undismiss") {
  const auth = await authenticateDevice(request);
  if (!auth.ok) return auth.response;
  const session = await resolveSessionUser(request);
  if (!session) return err("Employee session required", 401, { code: "session_required" });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("Invalid body", 400, { code: "validation_error" });
  }
  const parsed = dismissalInput.safeParse(body);
  if (!parsed.success) return err("Invalid body", 400, { code: "validation_error" });
  const scope = await resolveWorkScope({
    userId: session.user_id,
    deviceId: auth.device.id,
    deviceLocationId: auth.device.location_id,
  });
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const authz = await authorizeMeasurementTaskLocation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { from: (table: string) => supabaseAdmin.from(table as never) as any },
    {
      general_location_ids: scope.location_ids,
      general_include_unlocated: scope.is_hq,
      support_location_ids: scope.support_location_ids,
      support_include_unlocated: scope.support_include_unlocated,
    },
    parsed.data.task_id,
  );
  if (!authz.ok) return err(authz.message, authz.status, { code: authz.code });
  const result = await applyMeasurementDismissal(
    {
      rpc: async (name, args) => {
        // 必须以方法调用形式走原 client（rpc 内部依赖 this.rest），不能拆成独立变量。
        const client = supabaseAdmin as unknown as {
          rpc: (
            n: string,
            a: Record<string, unknown>,
          ) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
        };
        const { data, error } = await client.rpc(name, args);
        return { data, error: error ? { message: error.message, code: error.code } : null };
      },
    },
    { user_id: session.user_id, location_ids: [authz.location_id] },
    body,
    mode,
  );
  if (!result.ok) {
    return err(result.message, result.status, {
      code: result.code,
      ...(result.current_version ? { current_version: result.current_version } : {}),
    });
  }
  return ok(result.data);
}

export const Route = createFileRoute("/api/public/handheld/work-items/measurement-dismissals")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => handle(request, "dismiss"),
      DELETE: async ({ request }) => handle(request, "undismiss"),
    },
  },
});
