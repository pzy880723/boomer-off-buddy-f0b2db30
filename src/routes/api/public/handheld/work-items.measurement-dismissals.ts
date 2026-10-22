import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { resolveNotificationScope } from "@/server/handheld-notifications.server";
import { applyMeasurementDismissal } from "@/server/measurement-dismissals.server";

// 测量任务「个人忽略」：POST 忽略 / DELETE 撤销，body 均为
// { location_id, task_id, request_version }。员工身份只取 session，绝不信任 body user_id；
// 门店授权在 DB 写之前完成，任务归属/状态/版本由 DB 函数原子复核。
async function handle(request: Request, mode: "dismiss" | "undismiss") {
  const auth = await authenticateDevice(request);
  if (!auth.ok) return auth.response;
  const session = await resolveSessionUser(request);
  if (!session) return err("Employee session required", 401, { code: "session_required" });
  const scope = await resolveNotificationScope({
    userId: session.user_id,
    deviceId: auth.device.id,
    deviceLocationId: auth.device.location_id,
  });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("Invalid body", 400, { code: "validation_error" });
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const result = await applyMeasurementDismissal(
    {
      rpc: async (name, args) => {
        const { data, error } = await supabaseAdmin.rpc(name, args);
        return { data, error: error ? { message: error.message, code: error.code } : null };
      },
    },
    { user_id: session.user_id, location_ids: scope.locationIds },
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
