import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enqueueOrderSyncWindows, runOrderSyncSliceOnce } from "@/server/youzan-order-sync.server";

// 定时同步有赞订单 / 商品。每 30 分钟由 pg_cron 触发，days 默认 3 天做增量。
// 商品仍走旧 worker；订单改走「固定窗口游标队列」——本次只推进少量切片，
// 剩余窗口由后续调度续跑，不会在单次请求里跑满历史积压。
export const Route = createFileRoute("/api/public/hooks/youzan-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let days = 3;
        let slices = 3;
        try {
          const body = (await request.json()) as { days?: number; slices?: number };
          if (typeof body?.days === "number" && body.days >= 1 && body.days <= 180) {
            days = Math.floor(body.days);
          }
          if (typeof body?.slices === "number" && body.slices >= 0 && body.slices <= 10) {
            slices = Math.floor(body.slices);
          }
        } catch {
          // empty body ok
        }

        const { data: shops, error } = await supabaseAdmin
          .from("youzan_shops")
          .select("id, role")
          .eq("status", "active");
        if (error) {
          return new Response(JSON.stringify({ ok: false, error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const origin = new URL(request.url).origin;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const apikey = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (apikey) headers.apikey = apikey;

        let dispatched = 0;
        for (const shop of shops ?? []) {
          void fetch(`${origin}/api/public/hooks/youzan-sync-worker`, {
            method: "POST",
            headers,
            body: JSON.stringify({ shop_id: shop.id, action: "items", days }),
          }).catch((e) => {
            console.error("[cron youzan-sync dispatch]", shop.id, "items", e);
          });
          dispatched += 1;
        }

        // 订单：登记固定窗口 + 推进有界切片
        let windows = 0;
        const sliceResults: Record<string, unknown>[] = [];
        try {
          const enqueued = await enqueueOrderSyncWindows({ days });
          windows = enqueued.windows;
          const workerId = `cron-${Date.now()}`;
          for (let i = 0; i < slices; i += 1) {
            const r = await runOrderSyncSliceOnce({ workerId, maxPages: 2, leaseSeconds: 120 });
            sliceResults.push(r);
            if (r["claimed"] === false) break;
          }
        } catch (e) {
          console.error("[cron youzan-sync orders]", e);
        }

        return new Response(
          JSON.stringify({
            ok: true,
            dispatched,
            days,
            shopCount: shops?.length ?? 0,
            order_windows: windows,
            order_slices: sliceResults,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
