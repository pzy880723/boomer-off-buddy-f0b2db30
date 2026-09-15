import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";
import {
  confirmShortageRefund,
  createShortageDeps,
  getShortageCase,
} from "@/server/shortage-refund.server";
import { kickShortageRefund } from "@/server/shortage-refund-runtime.server";

const Body = z.object({
  // accept / cancel 都表示「同意按缺货处理」，一律进入同一条退款意图事务
  action: z.enum(["accept", "cancel"]),
  note: z.string().trim().max(400).optional(),
});

/**
 * 旧版客户答复入口（小程序历史版本仍在调用）。
 * 不再只改意见：命中真实报价时走与 confirm-refund 完全相同的退款意图事务。
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
        const deps = createShortageDeps();
        // 读时补报价：历史缺货也能在这里拿到服务端核算的真实金额
        const current = await getShortageCase(deps, auth.customer.id, params.id);
        if (!current) return storefrontError("Shortage not found", 404, "not_found");
        if (!current.can_confirm || !current.quote_version) {
          // 无可验证金额 → 人工复核，绝不编造退款
          return storefrontJson({ ok: true, data: current });
        }
        const result = await confirmShortageRefund(deps, {
          customerId: auth.customer.id,
          shortageId: params.id,
          quoteVersion: current.quote_version,
        });
        if (result.status === 200) {
          await kickShortageRefund(params.id);
          const fresh = await getShortageCase(deps, auth.customer.id, params.id);
          if (fresh) return storefrontJson({ ok: true, data: fresh });
        }
        return storefrontJson(result.body, { status: result.status });
      },
    },
  },
});
