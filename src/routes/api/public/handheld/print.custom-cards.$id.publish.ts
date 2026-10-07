import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS } from "@/server/handheld-auth.server";
import { publishCard } from "@/server/custom-print-cards.server";
import { customCardDeps } from "@/server/custom-print-cards-db.server";
import { readBody, withActor } from "@/server/custom-print-cards-http.server";

export const Route = createFileRoute("/api/public/handheld/print/custom-cards/$id/publish")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: ({ request, params }) => withActor(request, async (a) => publishCard(customCardDeps(), a, params.id, await readBody(request))),
    },
  },
});
