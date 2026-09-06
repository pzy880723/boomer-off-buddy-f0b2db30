import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";
import { ensureCustomerConversation, listCustomerConversations } from "@/server/support.server";

const Body = z.object({
  title: z.string().trim().max(200).optional(),
  topic: z.string().trim().max(60).optional(),
  order_id: z.string().uuid().optional(),
  location_id: z.string().uuid().optional(),
});

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
        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json().catch(() => ({})));
        } catch (error) {
          return storefrontError(`Invalid body: ${String(error)}`, 400, "validation_error");
        }
        const id = await ensureCustomerConversation({
          customerId: auth.customer.id,
          customerName: auth.customer.nickname ?? "顾客",
          locationId: body.location_id ?? null,
          orderId: body.order_id ?? null,
          title: body.title ?? null,
          topic: body.topic,
        });
        return storefrontJson({ ok: true, data: { conversation_id: id } });
      },
    },
  },
});
