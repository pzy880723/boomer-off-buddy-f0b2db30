import { createFileRoute } from "@tanstack/react-router";
import { reserveRecognitionQuota } from "@/lib/membership/membership-repository.server";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";

export const Route = createFileRoute("/api/public/storefront/membership/recognition-quota/reserve")(
  {
    server: {
      handlers: {
        OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
        POST: async ({ request }) => {
          const auth = await authenticateStorefrontCustomer(request);
          if (!auth.ok) return auth.response;
          const body = (await request.json().catch(() => null)) as { request_id?: unknown } | null;
          const requestId = typeof body?.request_id === "string" ? body.request_id.trim() : "";
          if (!requestId) {
            return storefrontError(
              "Missing recognition request id",
              422,
              "recognition_request_id_required",
            );
          }
          try {
            const data = await reserveRecognitionQuota(auth.customer.id, requestId);
            return storefrontJson({ ok: true, data });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const exhausted = /quota exhausted/i.test(message);
            return storefrontError(
              exhausted ? "今日识别次数已用尽，明天继续探索" : message,
              exhausted ? 409 : 500,
              exhausted ? "recognition_daily_limit_reached" : undefined,
            );
          }
        },
      },
    },
  },
);
