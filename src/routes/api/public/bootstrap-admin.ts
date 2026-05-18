import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const PHONE_REGEX = /^1[3-9]\d{9}$/;
const DEFAULT_PASSWORD = "pzy5565283";

function getAdmin() {
  const url = process.env.SUPABASE_URL!;
  // 优先使用新版 sb_secret_ 密钥（legacy 服务端密钥已被禁用时必需）
  const key =
    process.env.SUPABASE_SECRET_KEYS ||
    process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const Route = createFileRoute("/api/public/bootstrap-admin")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
        const url = new URL(request.url);
        const phone = (url.searchParams.get("phone") ?? "").trim();
        const password = url.searchParams.get("password") ?? DEFAULT_PASSWORD;

        if (!PHONE_REGEX.test(phone)) {
          return Response.json(
            {
              ok: false,
              error:
                "请在 URL 中提供合法的中国大陆 11 位手机号，例如 /api/public/bootstrap-admin?phone=13800138000",
            },
            { status: 400, headers },
          );
        }

        const admin = getAdmin();

        let exists = false;
        for (let page = 1; page <= 20; page++) {
          const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
          if (error) {
            return Response.json({ ok: false, error: error.message }, { status: 500, headers });
          }
          if (data.users.some((u) => u.phone === phone)) {
            exists = true;
            break;
          }
          if (data.users.length < 200) break;
        }

        if (exists) {
          return Response.json({ ok: true, already: true, phone }, { headers });
        }

        const { error } = await admin.auth.admin.createUser({
          phone,
          password,
          phone_confirm: true,
        });
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500, headers });
        }
        return Response.json({ ok: true, created: true, phone }, { headers });
      },
    },
  },
});
