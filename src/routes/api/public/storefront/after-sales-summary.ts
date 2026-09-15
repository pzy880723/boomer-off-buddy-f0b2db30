import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontJson,
} from "@/server/storefront-auth.server";
import { createShortageDeps, getAfterSalesSummary } from "@/server/shortage-refund.server";
import { countStorefrontOrders } from "@/server/storefront-order-list-query.server";
import { loadStorefrontSummary } from "@/server/storefront-summary.server";

/**
 * 「我的订单 / 售后」角标汇总。
 * - pending_count：仍须客户处理的售后单数（纯计数），与通知已读状态无关。
 * - order_counts：本人订单数（不是商品件数），与订单列表筛选同一判定，完整分页计数。
 * - 无服务端缓存：确认退款后立刻生效；不查积分 / 优惠券。
 */
export const Route = createFileRoute("/api/public/storefront/after-sales-summary")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const data = await loadStorefrontSummary(auth.customer.id, {
          afterSales: (customerId: string) =>
            getAfterSalesSummary(createShortageDeps(), customerId),
          orderCounts: (customerId: string) =>
            countStorefrontOrders({ client: supabaseAdmin, customerId }),
        });
        return storefrontJson({ ok: true, data });
      },
    },
  },
});
