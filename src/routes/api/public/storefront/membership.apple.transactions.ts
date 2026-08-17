import { createFileRoute } from "@tanstack/react-router";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
} from "@/server/storefront-auth.server";

export const Route = createFileRoute("/api/public/storefront/membership/apple/transactions")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        return storefrontError(
          "Apple 服务端交易验证尚未配置",
          503,
          "payment_provider_not_configured",
        );
      },
    },
  },
});
