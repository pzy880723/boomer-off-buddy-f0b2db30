// POST /api/public/go/authorization-ack
// GO 应用授权后回执：仍用本人 GO JWT 核验，回执内容只从 GO 无参可信 RPC 读取，
// 不相信请求体里的任何 id / ok。只确认该用户自己的待同步记录。
import { createFileRoute } from "@tanstack/react-router";
import {
  GO_AUTHZ_CORS,
  authenticateGoIdentity,
  authzError,
  authzJson,
  confirmAuthorizationReceipt,
} from "@/server/go-authorization.server";

export const Route = createFileRoute("/api/public/go/authorization-ack")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: GO_AUTHZ_CORS }),
      POST: async ({ request }) => {
        try {
          const identity = await authenticateGoIdentity(request);
          const result = await confirmAuthorizationReceipt(identity);
          return authzJson({
            ok: true,
            data: {
              erp_user_id: identity.erpUserId,
              scope_version: result.snapshot.scope_version,
              receipt_status: result.receipt_status,
              confirmed_events: result.confirmed,
              authorization: result.snapshot,
            },
          });
        } catch (e) {
          return authzError(e);
        }
      },
    },
  },
});
