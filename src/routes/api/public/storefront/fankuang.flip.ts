import { createFileRoute } from "@tanstack/react-router";
import { FlipRequest } from "@/lib/commerce/fankuang-gift";
import { STOREFRONT_CORS, authenticateStorefrontCustomer, storefrontError } from "@/server/storefront-auth.server";
import { callFankuangRpc, fankuangOk } from "@/server/storefront-fankuang.server";

// POST {session_id, listing_id, client_op_id}：服务端记录有效唯一翻动并做一次 1% 抽取；重试/回翻不重抽。
export const Route = createFileRoute("/api/public/storefront/fankuang/flip")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const parsed = FlipRequest.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return storefrontError("Invalid request", 400, "invalid_request");
        const r = await callFankuangRpc("commerce_fankuang_flip", {
          p_customer_id: auth.customer.id,
          p_session_id: parsed.data.session_id,
          p_listing_id: parsed.data.listing_id,
          p_client_op_id: parsed.data.client_op_id,
        });
        return r instanceof Response ? r : fankuangOk(r.data);
      },
    },
  },
});
