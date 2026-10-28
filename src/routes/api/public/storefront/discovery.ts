import { createFileRoute } from "@tanstack/react-router";
import { STOREFRONT_CORS, storefrontError, storefrontJson } from "@/server/storefront-auth.server";
import { loadDiscovery } from "@/server/storefront-engagement.server";
import { resolveRequestConsumerChannel } from "@/server/sales-channels.server";

// 无真实数据时 terms 为空、source=preset，前端改用现有精选标签。
export const Route = createFileRoute("/api/public/storefront/discovery")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        try {
          // 渠道展示过滤：来源只认验签会话 client_kind；匿名仅以 storefront_channel 作展示上下文（缓存按 URL + 授权头区分）。
          const channel = await resolveRequestConsumerChannel(request);
          return storefrontJson({ ok: true, data: await loadDiscovery(undefined, channel) },
            { headers: { "Cache-Control": "public, max-age=300", Vary: "Authorization" } });
        } catch {
          return storefrontError("热门发现加载失败", 500);
        }
      },
    },
  },
});
