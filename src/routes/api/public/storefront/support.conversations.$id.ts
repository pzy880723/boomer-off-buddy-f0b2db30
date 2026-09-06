import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";
import { getCustomerConversation, postCustomerMessage } from "@/server/support.server";

const Body = z.object({
  body: z.string().trim().min(1).max(4000),
  client_op_id: z.string().trim().min(1).max(120),
});

export const Route = createFileRoute("/api/public/storefront/support/conversations/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const result = await getCustomerConversation(auth.customer.id, params.id);
        if (!result.ok) return storefrontError("Conversation not found", 404, result.code);
        return storefrontJson({ ok: true, data: result.data });
      },
      POST: async ({ request, params }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch (error) {
          return storefrontError(`Invalid body: ${String(error)}`, 400, "validation_error");
        }
        const result = await postCustomerMessage({
          customerId: auth.customer.id,
          customerName: auth.customer.nickname ?? "顾客",
          conversationId: params.id,
          body: body.body,
          clientOpId: body.client_op_id,
        });
        if (!result.ok) return storefrontError("Conversation not found", 404, result.code);
        return storefrontJson({ ok: true, data: result.data });
      },
    },
  },
});
