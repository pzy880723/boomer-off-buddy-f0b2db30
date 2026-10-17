import { createFileRoute } from "@tanstack/react-router";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";

// 顾客只读：新人券包发放进度 not_enrolled / processing / issued / needs_retry。券本身以会员券列表为准。
export const Route = createFileRoute("/api/public/storefront/membership/newcomer-benefit")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        try {
          const { newcomerSummary } = await import("@/server/newcomer-benefit-production.server");
          return storefrontJson({ ok: true, data: await newcomerSummary(auth.customer.id) }, {
            headers: { "cache-control": "private, no-store" } });
        } catch {
          return storefrontError("新人礼包状态暂时无法读取，请稍后重试", 500);
        }
      },
    },
  },
});
