// GET/POST /api/public/handheld/privacy/ai-consent
// 员工本人 AI 处理授权。user_id 只取自已验证的员工 session，body 不能指定用户。
import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, json, resolveSessionUser } from "@/server/handheld-auth.server";
import { dbConsentStore } from "@/server/ai-consent.server";
import { handleConsentRead, handleConsentWrite } from "@/server/ai-consent-core";

const noStore = { "Cache-Control": "no-store" };

export const Route = createFileRoute("/api/public/handheld/privacy/ai-consent")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        const r = await handleConsentRead({ store: dbConsentStore(), userId: session?.user_id ?? null });
        return json(r.body, { status: r.status, headers: noStore });
      },
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        const raw = await request.json().catch(() => null);
        const r = await handleConsentWrite({
          store: dbConsentStore(),
          userId: session?.user_id ?? null,
          deviceId: auth.device.id,
          raw,
        });
        return json(r.body, { status: r.status, headers: noStore });
      },
    },
  },
});
