import { createFileRoute } from "@tanstack/react-router";
import { STOREFRONT_CORS, authenticateStorefrontCustomer } from "@/server/storefront-auth.server";
import { callFankuangRpc, fankuangOk } from "@/server/storefront-fankuang.server";

// GET：{available, reserved, consumed, available_entitlements:[{id, won_at}]}；资格不随午夜清空。
export const Route = createFileRoute("/api/public/storefront/fankuang/gift-balance")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const r = await callFankuangRpc("commerce_fankuang_gift_balance", { p_customer_id: auth.customer.id });
        return r instanceof Response ? r : fankuangOk(r.data);
      },
    },
  },
});
