import { createFileRoute } from "@tanstack/react-router";
import { listMembershipPlans } from "@/lib/membership/membership-repository.server";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";

export const Route = createFileRoute("/api/public/storefront/membership/plans")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const platform = new URL(request.url).searchParams.get("platform") ?? "ios";
        if (!new Set(["ios", "android", "wechat_mini_program"]).has(platform)) {
          return storefrontError("Invalid membership platform", 422, "invalid_membership_platform");
        }
        try {
          return storefrontJson({ ok: true, data: await listMembershipPlans(platform) });
        } catch (error) {
          return storefrontError(error instanceof Error ? error.message : String(error), 500);
        }
      },
    },
  },
});
