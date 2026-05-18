import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BodySchema = z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/, "手机号格式不正确"),
});

export const Route = createFileRoute("/api/public/auth-precheck")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400, headers });
        }
        const parsed = BodySchema.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" },
            { status: 400, headers },
          );
        }
        const phone = parsed.data.phone;

        let exists = false;
        let systemEmpty = false;
        for (let page = 1; page <= 20; page++) {
          const { data, error } = await supabaseAdmin.auth.admin.listUsers({
            page,
            perPage: 200,
          });
          if (error) {
            return Response.json({ ok: false, error: error.message }, { status: 500, headers });
          }
          if (page === 1 && data.users.length === 0) {
            systemEmpty = true;
            break;
          }
          if (data.users.some((u) => u.phone === phone)) {
            exists = true;
            break;
          }
          if (data.users.length < 200) break;
        }

        return Response.json({ ok: true, exists, systemEmpty }, { headers });
      },
    },
  },
});
