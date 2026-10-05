import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";
import { ensureCustomerConversation, listCustomerConversations } from "@/server/support.server";
import { supportError } from "@/lib/support-policy";

// 门店由服务端从订单行 / 商品派生；location_id 只在无订单、无商品的一般咨询时生效。
const Body = z
  .object({
    title: z.string().trim().max(200, "标题不超过 200 字").optional(),
    topic: z.string().trim().max(60, "主题不超过 60 字").optional(),
    order_id: z.string().uuid("订单编号格式不正确").optional(),
    product_id: z.string().uuid("商品编号格式不正确").optional(),
    location_id: z.string().uuid("门店编号格式不正确").optional(),
  })
  .refine((v) => !(v.order_id && v.product_id), { message: "订单与商品只能二选一" });

export const Route = createFileRoute("/api/public/storefront/support/conversations")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const items = await listCustomerConversations(auth.customer.id);
        return storefrontJson({ ok: true, data: { items } });
      },
      POST: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const parsed = Body.safeParse(await request.json().catch(() => ({})));
        if (!parsed.success) {
          return storefrontError(
            parsed.error.issues[0]?.message ?? "参数不正确",
            400,
            "validation_error",
          );
        }
        const body = parsed.data;
        const result = await ensureCustomerConversation({
          customerId: auth.customer.id,
          customerName: auth.customer.nickname ?? "顾客",
          locationId: body.location_id ?? null,
          orderId: body.order_id ?? null,
          productId: body.product_id ?? null,
          title: body.title ?? null,
          topic: body.topic,
        });
        if (!result.ok) {
          const e = supportError(result.code);
          return storefrontError(e.message, e.status, result.code);
        }
        return storefrontJson({
          ok: true,
          data: { conversation_id: result.id, reused: result.reused },
        });
      },
    },
  },
});
