// GET /api/public/go/session
// BOOMER GO 店员端只读会话：核验 GO Supabase token → ERP 身份/角色/当天排班门店。
// 与手持设备认证（X-Device-Token）完全独立，互不影响。
import { createFileRoute } from "@tanstack/react-router";
import {
  GO_CORS,
  authenticateGoActor,
  goError,
  goJson,
  goSessionPayload,
} from "@/server/go-bridge.server";

export const Route = createFileRoute("/api/public/go/session")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: GO_CORS }),
      GET: async ({ request }) => {
        try {
          const actor = await authenticateGoActor(request);
          return goJson({ ok: true, data: goSessionPayload(actor) });
        } catch (e) {
          return goError(e);
        }
      },
    },
  },
});
