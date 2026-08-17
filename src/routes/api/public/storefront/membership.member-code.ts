import { createFileRoute } from "@tanstack/react-router";
import { createMembershipCode } from "@/lib/membership/membership-repository.server";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";

export const Route = createFileRoute("/api/public/storefront/membership/member-code")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        try {
          return storefrontJson(
            { ok: true, data: await createMembershipCode(auth.customer.id) },
            { status: 201 },
          );
        } catch (error) {
          return storefrontError(error instanceof Error ? error.message : String(error), 500);
        }
      },
    },
  },
});
