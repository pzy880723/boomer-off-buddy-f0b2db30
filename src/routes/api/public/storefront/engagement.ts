import { createFileRoute } from "@tanstack/react-router";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontPrivateJson,
} from "@/server/storefront-auth.server";
import { EngagementBody } from "@/lib/commerce/storefront-engagement";
import { recordEngagement } from "@/server/storefront-engagement.server";

// 第一版只统计已验证登录顾客；顾客身份只取自令牌，不接受 user_id/总数。
export const Route = createFileRoute("/api/public/storefront/engagement")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const parsed = EngagementBody.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return storefrontError("参数不正确", 400, "validation_error");
        try {
          const result = await recordEngagement(auth.customer.id, parsed.data);
          if (result.reason === "rate_limited") return storefrontError("操作过于频繁", 429, "rate_limited");
          if (result.reason === "product_unavailable") return storefrontError("商品不可用", 404, "product_unavailable");
          return storefrontPrivateJson({ ok: true, data: result });
        } catch {
          return storefrontError("记录失败", 500, "engagement_failed");
        }
      },
    },
  },
});
