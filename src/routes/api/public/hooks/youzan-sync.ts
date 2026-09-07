import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enqueueOrderSyncWindows, runOrderSyncSliceOnce } from "@/server/youzan-order-sync.server";
import { requireYouzanSyncService, dispatchYouzanSyncWorker } from "@/server/youzan-sync-auth.server";

// 定时同步有赞订单 / 商品。仅允许后台 Bearer；days 默认 3 天做增量。
// 商品仍走旧 worker；订单改走「固定窗口游标队列」——本次只推进少量切片，
// 剩余窗口由后续调度续跑，不会在单次请求里跑满历史积压。
export const Route = createFileRoute("/api/public/hooks/youzan-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = requireYouzanSyncService(request);
        if (denied) return denied;
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

        let dispatched = 0;
        for (const shop of shops ?? []) {
          dispatchYouzanSyncWorker({ shop_id: shop.id, action: "items", days });
          dispatched += 1;
        }

        // 订单：登记固定窗口 + 推进有界切片
        let windows = 0;
        const sliceResults: Record<string, unknown>[] = [];
        let queueError: string | null = null;
        try {
          const enqueued = await enqueueOrderSyncWindows({ days });
          windows = enqueued.windows;
          const workerId = `cron-${crypto.randomUUID()}`;
          for (let i = 0; i < slices; i += 1) {
            const r = await runOrderSyncSliceOnce({ workerId, maxPages: 2, leaseSeconds: 120 });
            sliceResults.push(r);
            if (r["claimed"] === false) break;
          }
        } catch (e) {
          console.error("[cron youzan-sync orders]", e);
          queueError = "order_queue_failed";
        }

        const failed = sliceResults.some((r) => r.claimed === true &&
          (r.applied === false || r.status === "error" || r.status === "failed"));
        return new Response(
          JSON.stringify({
            ok: queueError === null && !failed,
            order_error: queueError,
            dispatched,
            days,
            shopCount: shops?.length ?? 0,
            order_windows: windows,
            order_slices: sliceResults,
          }),
          { status: queueError ? 500 : failed ? 207 : 200, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
