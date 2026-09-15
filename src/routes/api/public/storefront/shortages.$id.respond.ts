import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";
import { createShortageDeps } from "@/server/shortage-refund.server";
import { handleRespond } from "@/server/shortage-routes.server";
import { kickShortageRefund } from "@/server/shortage-refund-runtime.server";

const Body = z.object({
  // accept / cancel 都表示「同意按缺货处理」，一律进入同一条退款意图事务
  action: z.enum(["accept", "cancel"]),
  note: z.string().trim().max(400).optional(),
});

/**
 * 旧版客户答复入口（小程序历史版本仍在调用）。
 * 不再只改意见：命中真实报价时走与 confirm-refund 完全相同的退款意图事务；
 * 退款执行未开启时同样 503，不落任何确认写入。
 */
export const Route = createFileRoute("/api/public/storefront/shortages/$id/respond")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        try {
          Body.parse(await request.json());
        } catch (error) {
          return storefrontError(`Invalid body: ${String(error)}`, 400, "validation_error");
        }
        const result = await handleRespond(
          {
            deps: createShortageDeps(),
            kick: async (shortageId) => {
              const outcome = await kickShortageRefund(shortageId);
              return { executed: outcome.executed };
            },
          },
          { customerId: auth.customer.id, shortageId: params.id },
        );
        return storefrontJson(result.body, { status: result.status });
      },
    },
  },
});
