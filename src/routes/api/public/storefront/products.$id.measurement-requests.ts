import { createFileRoute } from "@tanstack/react-router";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";
import { requestMeasurementProduction } from "@/server/product-measurement-production.server";

function privateNoStore(res: Response) {
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("Vary", "Authorization");
  return res;
}

/**
 * POST /api/public/storefront/products/{id}/measurement-requests
 * 顾客申请测量商品尺寸（事务 RPC：同商品合并一个活跃任务、记录申请者、
 * 首次建任务时生成门店手持提醒，原子完成）。登录必填；重复申请幂等；
 * 已有实测直接返回 completed + 完整 measurement；售罄照常受理，不改库存。
 *
 * 无门店正库存/多店无法确定实物门店：status:'unavailable' + 中文 message，不建任务、不广播、不记申请者。
 * 响应：{ ok:true, data:{ status:'pending'|'completed'|'unavailable', task_id, requested_at, measurement?, message? } }
 */
export const Route = createFileRoute("/api/public/storefront/products/$id/measurement-requests")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      POST: async ({ params, request }) =>
        privateNoStore(
          await (async () => {
            const auth = await authenticateStorefrontCustomer(request);
            if (!auth.ok) return auth.response;
            try {
              const result = await requestMeasurementProduction(params.id, auth.customer.id);
              return storefrontJson({ ok: true, data: result });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (message === "not_found") return storefrontError("Product not found", 404);
              return storefrontError(message, 500);
            }
          })(),
        ),
    },
  },
});
