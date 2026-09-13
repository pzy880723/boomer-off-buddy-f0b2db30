import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";
import { confirmShortageRefund, createShortageDeps } from "@/server/shortage-refund.server";
import { confirmIdempotencyKey } from "@/lib/shortage-refund/case";

const Body = z.object({ quote_version: z.string().trim().min(1).max(120) });

export const Route = createFileRoute("/api/public/storefront/shortages/$id/confirm-refund")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch (error) {
          return storefrontError(`Invalid body: ${String(error)}`, 400, "validation_error");
        }
        const header = request.headers.get("Idempotency-Key");
        const expected = confirmIdempotencyKey(params.id, body.quote_version);
        if (header && header !== expected) {
          return storefrontError("Idempotency-Key mismatch", 400, "validation_error");
        }
        const result = await confirmShortageRefund(createShortageDeps(), {
          customerId: auth.customer.id,
          shortageId: params.id,
          quoteVersion: body.quote_version,
        });
        return storefrontJson(result.body, { status: result.status });
      },
    },
  },
});
