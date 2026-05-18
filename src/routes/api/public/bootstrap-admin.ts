import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const PHONE_REGEX = /^1[3-9]\d{9}$/;
const DEFAULT_PASSWORD = "pzy5565283";

export const Route = createFileRoute("/api/public/bootstrap-admin")({
  server: {
    handlers: {
      GET: async ({ request }) => {
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
            { status: 400, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } },
          );
        }

        // 翻页查找该手机号
        let exists = false;
        for (let page = 1; page <= 20; page++) {
          const { data, error } = await supabaseAdmin.auth.admin.listUsers({
            page,
            perPage: 200,
          });
          if (error) {
            return Response.json({ ok: false, error: error.message }, { status: 500 });
          }
          if (data.users.some((u) => u.phone === phone)) {
            exists = true;
            break;
          }
          if (data.users.length < 200) break;
        }

        if (exists) {
          return Response.json(
            { ok: true, already: true, phone },
            { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } },
          );
        }

        const { error } = await supabaseAdmin.auth.admin.createUser({
          phone,
          password,
          phone_confirm: true,
        });
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }
        return Response.json(
          { ok: true, created: true, phone },
          { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } },
        );
      },
    },
  },
});
