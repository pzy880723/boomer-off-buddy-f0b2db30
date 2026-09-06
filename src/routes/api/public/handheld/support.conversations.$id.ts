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

const Body = z.object({
  body: z.string().trim().min(1).max(4000),
  internal: z.boolean().default(false),
  client_op_id: z.string().trim().min(1).max(120),
});

export const Route = createFileRoute("/api/public/handheld/support/conversations/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return err("Employee session required", 401, { code: "session_required" });
        const access = await resolveSupportAccess(session.user_id);
        const result = await getStaffConversation(access, params.id);
        if (!result.ok) {
          return err(result.code, result.code === "forbidden" ? 403 : 404, { code: result.code });
        }
        return ok(result.data);
      },
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return err("Employee session required", 401, { code: "session_required" });
        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch (error) {
          return err("Invalid body", 400, { code: "validation_error", detail: String(error) });
        }
        const access = await resolveSupportAccess(session.user_id);
        try {
          const result = await postStaffMessage({
            access,
            conversationId: params.id,
            body: body.body,
            internal: body.internal,
            clientOpId: body.client_op_id,
          });
          if (!result.ok) {
            return err(result.code, result.code === "forbidden" ? 403 : 404, { code: result.code });
          }
          return ok(result.data);
        } catch (error) {
          return err(error instanceof Error ? error.message : String(error), 500);
        }
      },
    },
  },
});
