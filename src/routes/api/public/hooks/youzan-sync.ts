import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// 定时同步有赞订单 / 商品。每 30 分钟由 pg_cron 触发，days 默认 3 天做增量。
// 支持 POST { days?: number }（1~180）。返回派发数量。
export const Route = createFileRoute("/api/public/hooks/youzan-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let days = 3;
        try {
          const body = (await request.json()) as { days?: number };
          if (typeof body?.days === "number" && body.days >= 1 && body.days <= 180) {
            days = Math.floor(body.days);
          }
        } catch {
          // empty body ok
        }

        const { data: shops, error } = await supabaseAdmin
          .from("youzan_shops")
          .select("id, role")
          .eq("status", "active");
        if (error) {
          return new Response(
            JSON.stringify({ ok: false, error: error.message }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        const origin = new URL(request.url).origin;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const apikey = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (apikey) headers.apikey = apikey;

        let dispatched = 0;
        for (const shop of shops ?? []) {
          const jobs: Array<"items" | "orders"> =
            shop.role === "hq" ? ["items"] : ["items", "orders"];
          for (const action of jobs) {
            void fetch(`${origin}/api/public/hooks/youzan-sync-worker`, {
              method: "POST",
              headers,
              body: JSON.stringify({ shop_id: shop.id, action, days }),
            }).catch((e) => {
              console.error("[cron youzan-sync dispatch]", shop.id, action, e);
            });
            dispatched += 1;
          }
        }

        return new Response(
          JSON.stringify({ ok: true, dispatched, days, shopCount: shops?.length ?? 0 }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
