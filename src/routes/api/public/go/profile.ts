// GET /api/public/go/profile — 已核验 GO 身份 → 已验证 ERP 映射 → ERP Auth 资料（只读）。
// 不接收客户端 ERP ID，不按手机号绑定，不涉及排班/权限。
import { createFileRoute } from "@tanstack/react-router";
import { GO_CORS, GoScopeError, goTraced } from "@/server/go-bridge.server";
import { authenticateGoIdentity } from "@/server/go-authorization.server";
import { loadStaffProfile } from "@/server/staff-profile.server";

const noStore = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...GO_CORS, "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });

export const Route = createFileRoute("/api/public/go/profile")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: GO_CORS }),
      GET: async ({ request }) =>
        goTraced("profile", async (timing) => {
          const identity = await authenticateGoIdentity(request, timing);
          let profile;
          try {
            profile = await loadStaffProfile(identity.erpUserId);
          } catch {
            throw new GoScopeError("profile_unavailable", "资料暂不可用", 503);
          }
          if (!profile) throw new GoScopeError("go_identity_not_linked", "该 GO 账号尚未绑定 ERP 账号", 403);
          return noStore({ ok: true, data: profile });
        }),
    },
  },
});
