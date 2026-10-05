import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { resolveSupportAccess, updateConversationAssignment } from "@/server/support.server";
import { supportError } from "@/server/support-policy";

const Body = z.object({
  action: z.enum(["claim", "takeover", "close", "reopen"], {
    message: "操作只能是 claim / takeover / close / reopen",
  }),
  assignment_version: z.number({ message: "缺少会话版本，请刷新后再操作" }).int().min(0),
});

export const Route = createFileRoute("/api/public/handheld/support/conversations/$id/assignment")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
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
          const result = await updateConversationAssignment({
            access,
            conversationId: params.id,
            action: parsed.data.action,
            assignmentVersion: parsed.data.assignment_version,
          });
          if (!result.ok) {
            const e = supportError(result.code);
            return err(e.message, e.status, { code: result.code, ...result.detail });
          }
          return ok(result.data);
        } catch (error) {
          return err(error instanceof Error ? error.message : String(error), 500);
        }
      },
    },
  },
});
