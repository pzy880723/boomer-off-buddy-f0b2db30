import { createFileRoute } from "@tanstack/react-router";
import { incrementShare } from "@/lib/content-supabase.server";

export const Route = createFileRoute("/api/public/content/$id/share")({
  server: {
    handlers: {
      POST: async ({ params }) =>
        Response.json({
          ok: true,
          share_count: await incrementShare(params.id),
        }),
    },
  },
});
