import { createFileRoute } from "@tanstack/react-router";
import { SessionStartRequest } from "@/lib/commerce/fankuang-gift";
import { STOREFRONT_CORS, authenticateStorefrontCustomer, storefrontError } from "@/server/storefront-auth.server";
import { callFankuangRpc, fankuangOk } from "@/server/storefront-fankuang.server";

// GET：当前进行中的冻结快照（无则 data:null）。POST {client_op_id}：开始/恢复一筐，同 op 重放。
export const Route = createFileRoute("/api/public/storefront/fankuang/session")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const r = await callFankuangRpc("commerce_fankuang_current_session", { p_customer_id: auth.customer.id });
        return r instanceof Response ? r : fankuangOk(r.data ?? null);
      },
      POST: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const parsed = SessionStartRequest.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return storefrontError("Invalid request", 400, "invalid_request");
        const r = await callFankuangRpc("commerce_fankuang_start_session", {
          p_customer_id: auth.customer.id,
          p_client_op_id: parsed.data.client_op_id,
        });
        return r instanceof Response ? r : fankuangOk(r.data);
      },
    },
  },
});
