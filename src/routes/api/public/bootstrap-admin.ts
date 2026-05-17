import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const ADMIN_EMAIL = "87113911@qq.com";
const ADMIN_PASSWORD = "pzy5565283";

export const Route = createFileRoute("/api/public/bootstrap-admin")({
  server: {
    handlers: {
      GET: async () => {
        // 翻页查找该邮箱（listUsers 默认 50/页）
        let exists = false;
        for (let page = 1; page <= 20; page++) {
          const { data, error } = await supabaseAdmin.auth.admin.listUsers({
            page,
            perPage: 200,
          });
          if (error) {
            return Response.json({ ok: false, error: error.message }, { status: 500 });
          }
          if (data.users.some((u) => u.email?.toLowerCase() === ADMIN_EMAIL)) {
            exists = true;
            break;
          }
          if (data.users.length < 200) break;
        }

        if (exists) {
          return Response.json({ ok: true, already: true, email: ADMIN_EMAIL });
        }

        const { error } = await supabaseAdmin.auth.admin.createUser({
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          email_confirm: true,
        });
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }
        return Response.json({ ok: true, created: true, email: ADMIN_EMAIL });
      },
    },
  },
});
