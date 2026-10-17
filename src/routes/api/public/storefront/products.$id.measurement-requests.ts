import { createFileRoute } from "@tanstack/react-router";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";
import {
  addRequesterProduction,
  createTaskProduction,
  findActiveTaskProduction,
  loadMeasurementListing,
  loadMeasurementSku,
} from "@/server/product-measurement-production.server";

function privateNoStore(res: Response) {
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("Vary", "Authorization");
  return res;
}

/**
 * POST /api/public/storefront/products/{id}/measurement-requests
 * 顾客申请测量商品尺寸。登录必填；同商品多用户合并为一个活跃任务；
 * 已有实测直接返回 completed；售罄商品如实处理，不改库存。
 *
 * 响应：{ ok:true, data:{ status:'pending'|'completed', task_id, requested_at } }
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
              const listing = await loadMeasurementListing(params.id);
              const readable =
                listing &&
                ["published", "reserved", "sold", "archived"].includes(listing.status) &&
                listing.published_at;
              if (!readable) return storefrontError("Product not found", 404);
              const sku = await loadMeasurementSku(listing.sku_id);
              if (!sku) return storefrontError("Product not found", 404);

              if (sku.measured_at) {
                return storefrontJson({
                  ok: true,
                  data: { status: "completed", task_id: null, requested_at: null },
                });
              }

              let task = await findActiveTaskProduction(sku.id);
              if (!task) {
                task = await createTaskProduction({
                  sku_id: sku.id,
                  listing_id: listing.id,
                  location_id: listing.location_id ?? sku.location_id,
                  status: "pending",
                  claimed_by: null,
                  claimed_at: null,
                  completed_at: null,
                  completed_by: null,
                });
              }
              await addRequesterProduction(task.id, auth.customer.id);
              return storefrontJson({
                ok: true,
                data: { status: "pending", task_id: task.id, requested_at: task.created_at },
              });
            } catch (error) {
              return storefrontError(error instanceof Error ? error.message : String(error), 500);
            }
          })(),
        ),
    },
  },
});
