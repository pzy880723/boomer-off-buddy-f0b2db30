// GET /api/public/go/authorization
// BOOMER GO 授权刷新通道：只用店员本人的 GO JWT，不需要任何 ERP 后台密钥。
// 返回 ERP 当前真实授权快照（含 revoked 墓碑），GO 据此刷新本地镜像。
import { createFileRoute } from "@tanstack/react-router";
import {
  GO_AUTHZ_CORS,
  authenticateGoIdentity,
  authzError,
  authzJson,
  loadAuthorizationSnapshot,
} from "@/server/go-authorization.server";

export const Route = createFileRoute("/api/public/go/authorization")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: GO_AUTHZ_CORS }),
      GET: async ({ request }) => {
        try {
          const identity = await authenticateGoIdentity(request);
          const snapshot = await loadAuthorizationSnapshot(identity.erpUserId, identity.goUserId);
          return authzJson({ ok: true, data: snapshot });
        } catch (e) {
          return authzError(e);
        }
      },
    },
  },
});
