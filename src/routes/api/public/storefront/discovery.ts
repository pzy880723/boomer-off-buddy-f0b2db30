import { createFileRoute } from "@tanstack/react-router";
import { STOREFRONT_CORS, storefrontError, storefrontJson } from "@/server/storefront-auth.server";
import { loadDiscovery } from "@/server/storefront-engagement.server";

// 无真实数据时 terms 为空、source=preset，前端改用现有精选标签。
export const Route = createFileRoute("/api/public/storefront/discovery")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async () => {
        try {
          return storefrontJson({ ok: true, data: await loadDiscovery() }, { headers: { "Cache-Control": "public, max-age=300" } });
        } catch {
          return storefrontError("热门发现加载失败", 500);
        }
      },
    },
  },
});
