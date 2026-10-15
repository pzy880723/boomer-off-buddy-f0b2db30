import { createFileRoute } from "@tanstack/react-router";
import { listMembershipPointsLedger } from "@/lib/membership/membership-repository.server";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";

export const Route = createFileRoute("/api/public/storefront/membership/points-ledger")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        try {
          const url = new URL(request.url);
          const ledger = await listMembershipPointsLedger(auth.customer.id, {
            cursor: url.searchParams.get("cursor"),
            limit: Number(url.searchParams.get("limit")) || undefined,
          });
          // data 保持数组兼容旧客户端；有赞来源/状态/查询范围在顶层 points_sync。
          return storefrontJson({ ok: true, data: ledger.rows, points_sync: ledger.points_sync });
        } catch (error) {
          return storefrontError(error instanceof Error ? error.message : String(error), 500);
        }
      },
    },
  },
});
