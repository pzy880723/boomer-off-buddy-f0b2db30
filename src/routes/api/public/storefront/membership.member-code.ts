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
        // 明确入会（取会员码）即登记新人券包：只写登记行、不等发券；失败不影响会员码。
        try {
          const { enrollNewcomerIfEnabled } = await import("@/server/newcomer-benefit-production.server");
          await enrollNewcomerIfEnabled(auth.customer.id, null);
        } catch {
          /* 登记失败由下一次取码重试，会员码照常返回 */
        }
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
