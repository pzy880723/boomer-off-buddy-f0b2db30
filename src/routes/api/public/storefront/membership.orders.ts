import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createMembershipOrder } from "@/lib/membership/membership-repository.server";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";

const OrderBody = z.object({
  plan_code: z.string().trim().min(1).max(80),
  platform: z.enum(["ios", "android", "wechat_mini_program"]),
  agreement_versions: z.record(z.string(), z.string()).default({}),
});

export const Route = createFileRoute("/api/public/storefront/membership/orders")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const idempotencyKey = request.headers.get("idempotency-key")?.trim();
        if (!idempotencyKey) return storefrontError("Missing Idempotency-Key", 400);
        let body: z.infer<typeof OrderBody>;
        try {
          body = OrderBody.parse(await request.json());
        } catch (error) {
          return storefrontError(`Invalid request: ${String(error)}`, 422);
        }
        try {
          const data = await createMembershipOrder({
            customerId: auth.customer.id,
            planCode: body.plan_code,
            platform: body.platform,
            idempotencyKey,
            agreementVersions: body.agreement_versions,
          });
          return storefrontJson({ ok: true, data }, { status: 201 });
        } catch (error) {
          return storefrontError(error instanceof Error ? error.message : String(error), 500);
        }
      },
    },
  },
});
