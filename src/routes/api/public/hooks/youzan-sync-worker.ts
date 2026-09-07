import { createFileRoute } from "@tanstack/react-router";
import { runShopSyncCore } from "@/lib/youzan.functions";
import { requireYouzanSyncService } from "@/server/youzan-sync-auth.server";

// ============================================================
// 单店单动作的后台同步入口（被 syncAllShops 用 fetch fire-and-forget）
// public 路径不代表匿名访问：任何读写前必须验证后台服务凭据。
// ============================================================
export const Route = createFileRoute("/api/public/hooks/youzan-sync-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = requireYouzanSyncService(request);
        if (denied) return denied;
        let body: { shop_id?: string; action?: string; days?: number };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
        }
        const shop_id = String(body.shop_id ?? "");
        const action = String(body.action ?? "");
        if (!shop_id || (action !== "items" && action !== "orders")) {
          return Response.json(
            { ok: false, error: "missing shop_id / action" },
            { status: 400 },
          );
        }
        try {
          const r = await runShopSyncCore({
            shop_id,
            action: action as "items" | "orders",
            days: typeof body.days === "number" ? body.days : undefined,
          });
          return Response.json({ ok: r.ok, count: r.count, message: r.message });
        } catch (e) {
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      },
    },
  },
});
