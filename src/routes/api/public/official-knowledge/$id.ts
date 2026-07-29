import { createFileRoute } from "@tanstack/react-router";
import { findPublicOfficialKnowledge } from "@/lib/content-supabase.server";

export const Route = createFileRoute("/api/public/official-knowledge/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const item = await findPublicOfficialKnowledge(params.id);
        if (!item) {
          return Response.json({ ok: false, error: "知识词条不存在" }, { status: 404 });
        }
        return Response.json({ ok: true, data: item });
      },
    },
  },
});
