import { createFileRoute } from "@tanstack/react-router";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontJson,
} from "@/server/storefront-auth.server";
import { createShortageDeps, getAfterSalesSummary } from "@/server/shortage-refund.server";

/** 小程序角标：客户仍须处理的售后数量；不依赖通知已读状态。 */
export const Route = createFileRoute("/api/public/storefront/after-sales-summary")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const data = await getAfterSalesSummary(createShortageDeps(), auth.customer.id);
        return storefrontJson({ ok: true, data });
      },
    },
  },
});
