import { createFileRoute } from "@tanstack/react-router";
import { findPublicContent } from "@/lib/content-supabase.server";
import { toPublicContentDto } from "@/lib/content-public";

export const Route = createFileRoute("/api/public/content/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const item = await findPublicContent(params.id);
          if (!item) return Response.json({ ok: false, error: "内容不存在" }, { status: 404 });
          return Response.json({ ok: true, data: toPublicContentDto(item) });
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : "内容读取失败" },
            { status: 500 },
          );
        }
      },
    },
  },
});
