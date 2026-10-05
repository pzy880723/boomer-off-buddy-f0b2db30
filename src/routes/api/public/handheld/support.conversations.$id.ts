import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import {
  getStaffConversation,
  postStaffMessage,
  resolveSupportAccess,
} from "@/server/support.server";
import { supportError } from "@/lib/support-policy";
import { parseMessageWindow } from "@/lib/support-message-window";

// 对外回复（internal=false）必须先领取并带 assignment_version；缺失返回 409 assignment_version_required，
// 不再悄悄绕过主接待人锁。内部备注不需要版本。
const Body = z.object({
  body: z.string().trim().min(1, "消息内容不能为空").max(4000, "消息不超过 4000 字"),
  internal: z.boolean().default(false),
  client_op_id: z.string().trim().min(1, "缺少消息编号").max(120),
  assignment_version: z.number().int().min(0).optional(),
  location_id: z.string().uuid("门店编号格式不正确").optional(),
});
const LocationId = z.string().uuid().nullable();

function fail(code: string, detail?: Record<string, unknown>) {
  const e = supportError(code);
  return err(e.message, e.status, { code, ...(detail ?? {}) });
}

export const Route = createFileRoute("/api/public/handheld/support/conversations/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return err("Employee session required", 401, { code: "session_required" });
        const url = new URL(request.url);
        const locationId = url.searchParams.get("location_id")?.trim() || null;
        if (!LocationId.safeParse(locationId).success) return fail("validation_error");
        const win = parseMessageWindow({
          limit: url.searchParams.get("limit"),
          before: url.searchParams.get("before"),
          after: url.searchParams.get("after"),
        });
        if (!win.ok) return fail(win.code);
        const access = await resolveSupportAccess(session.user_id);
        try {
          const result = await getStaffConversation(access, params.id, { locationId, window: win.window });
          if (!result.ok) return fail(result.code);
          return ok(result.data);
        } catch {
          return fail("internal_error");
        }
      },
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return err("Employee session required", 401, { code: "session_required" });
        const parsed = Body.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return err(parsed.error.issues[0]?.message ?? "参数不正确", 400, {
            code: "validation_error",
          });
        }
        const access = await resolveSupportAccess(session.user_id);
        try {
          const result = await postStaffMessage({
            access,
            conversationId: params.id,
            body: parsed.data.body,
            internal: parsed.data.internal,
            clientOpId: parsed.data.client_op_id,
            assignmentVersion: parsed.data.assignment_version ?? null,
            locationId: parsed.data.location_id ?? new URL(request.url).searchParams.get("location_id"),
          });
          if (!result.ok) return fail(result.code, result.detail);
          return ok(result.data);
        } catch (error) {
          return err(error instanceof Error ? error.message : String(error), 500);
        }
      },
    },
  },
});
