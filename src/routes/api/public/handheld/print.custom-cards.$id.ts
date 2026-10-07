import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS } from "@/server/handheld-auth.server";
import { deleteCard, getCard, patchCard } from "@/server/custom-print-cards.server";
import { customCardDeps } from "@/server/custom-print-cards-db.server";
import { readBody, withActor } from "@/server/custom-print-cards-http.server";

export const Route = createFileRoute("/api/public/handheld/print/custom-cards/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: ({ request, params }) => withActor(request, (a) =>
        getCard(customCardDeps(), a, params.id, new URL(request.url).searchParams.get("location_id") ?? "")),
      PATCH: ({ request, params }) => withActor(request, async (a) => patchCard(customCardDeps(), a, params.id, await readBody(request))),
      DELETE: ({ request, params }) => withActor(request, async (a) => deleteCard(customCardDeps(), a, params.id, await readBody(request))),
    },
  },
});
