import { createFileRoute } from "@tanstack/react-router";
import { toggleContentAction } from "@/lib/content-supabase.server";

export const Route = createFileRoute("/api/public/content/$id/bookmark")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        const userKey = request.headers.get("x-boomer-user-id")?.trim();
        if (!userKey) {
          return Response.json({ ok: false, error: "请先登录" }, { status: 401 });
        }
        return Response.json({
          ok: true,
          active: await toggleContentAction(params.id, userKey, "bookmark"),
        });
      },
    },
  },
});
