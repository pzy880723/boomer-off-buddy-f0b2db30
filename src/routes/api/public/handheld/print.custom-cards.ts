// GET  /api/public/handheld/print/custom-cards?location_id&state=custom|preset
// POST /api/public/handheld/print/custom-cards  → 202 持久化排队，由 listing-image-worker hook 后台生成
import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS } from "@/server/handheld-auth.server";
import { createCard, listCards } from "@/server/custom-print-cards.server";
import { customCardDeps } from "@/server/custom-print-cards-db.server";
import { readBody, withActor } from "@/server/custom-print-cards-http.server";

export const Route = createFileRoute("/api/public/handheld/print/custom-cards")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: ({ request }) => withActor(request, (a) => {
        const u = new URL(request.url);
        return listCards(customCardDeps(), a, { location_id: u.searchParams.get("location_id"), state: u.searchParams.get("state") });
      }),
      POST: ({ request }) => withActor(request, async (a) => createCard(customCardDeps(), a, await readBody(request))),
    },
  },
});
