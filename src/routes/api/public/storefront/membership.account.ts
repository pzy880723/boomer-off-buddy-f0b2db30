import { createFileRoute } from "@tanstack/react-router";
import { getMembershipAccount } from "@/lib/membership/membership-repository.server";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";

// 私有积分/账户数据：禁止任何代理或浏览器缓存。
function privateNoStore(res: Response) {
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("Vary", "Authorization");
  return res;
}

export const Route = createFileRoute("/api/public/storefront/membership/account")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => privateNoStore(await (async () => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        try {
          return storefrontJson({ ok: true, data: await getMembershipAccount(auth.customer.id) });
        } catch (error) {
          return storefrontError(error instanceof Error ? error.message : String(error), 500);
        }
      })()),
    },
  },
});
