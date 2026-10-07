// GET /api/public/account/profile — ERP Bearer only，只读当前员工 canonical 资料。
import { createFileRoute } from "@tanstack/react-router";
import { loadStaffProfile, resolveErpBearerUser } from "@/server/staff-profile.server";

const H = { "Content-Type": "application/json", "Cache-Control": "private, no-store" };
const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: H });

export const Route = createFileRoute("/api/public/account/profile")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const userId = await resolveErpBearerUser(request);
        if (!userId) return j({ ok: false, code: "unauthorized", error: "未登录" }, 401);
        try {
          const profile = await loadStaffProfile(userId);
          if (!profile) return j({ ok: false, code: "unauthorized", error: "账号不存在" }, 401);
          return j({ ok: true, data: profile });
        } catch {
          return j({ ok: false, code: "profile_unavailable", error: "资料暂不可用" }, 503);
        }
      },
    },
  },
});
