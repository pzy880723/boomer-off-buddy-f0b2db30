import { createFileRoute } from "@tanstack/react-router";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";
import { createShortageDeps, getShortageCase } from "@/server/shortage-refund.server";

export const Route = createFileRoute("/api/public/storefront/shortages/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const found = await getShortageCase(createShortageDeps(), auth.customer.id, params.id);
        // 非本人一律 404，不泄露存在性
        if (!found) return storefrontError("Shortage not found", 404, "not_found");
        return storefrontJson({ ok: true, data: found });
      },
    },
  },
});
