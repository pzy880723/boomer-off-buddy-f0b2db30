import { createFileRoute } from "@tanstack/react-router";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontJson,
} from "@/server/storefront-auth.server";
import { createShortageDeps, listShortageCases } from "@/server/shortage-refund.server";

export const Route = createFileRoute("/api/public/storefront/shortages")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const orderId = new URL(request.url).searchParams.get("order_id") ?? undefined;
        const items = await listShortageCases(createShortageDeps(), auth.customer.id, orderId || undefined);
        return storefrontJson({ ok: true, data: { items } });
      },
    },
  },
});
