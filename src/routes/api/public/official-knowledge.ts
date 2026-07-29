import { createFileRoute } from "@tanstack/react-router";
import { listPublicOfficialKnowledge } from "@/lib/content-supabase.server";

export const Route = createFileRoute("/api/public/official-knowledge")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const data = await listPublicOfficialKnowledge(
          url.searchParams.get("entity_type") ?? undefined,
          url.searchParams.get("entity_id") ?? undefined,
        );
        return Response.json({ ok: true, data });
      },
    },
  },
});
