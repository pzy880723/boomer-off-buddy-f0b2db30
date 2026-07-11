// 一次性测试：把测试 SKU 库存置 1 并同步到中信泰富分店（线上 + 线下）
// 调用方式：POST /api/public/hooks/test-publish-with-stock?sku_id=<uuid>
//   header apikey: <SUPABASE_PUBLISHABLE_KEY>
// 默认 SKU=70a6d177-97e7-4e99-be60-4fdcd2453575 (测试商品)
import { createFileRoute } from "@tanstack/react-router";

const DEFAULT_SKU = "70a6d177-97e7-4e99-be60-4fdcd2453575";
const BRANCH_SHOP_ID = "da06cdae-5ec1-4749-8dcb-dc972cfd05c9"; // 中信泰富
const BRANCH_LOCATION_ID = "7111b585-7d7f-4777-b4ae-61ce2b868f78"; // 中信泰富店库位

export const Route = createFileRoute("/api/public/hooks/test-publish-with-stock")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        if (!apikey || apikey !== process.env.SUPABASE_PUBLISHABLE_KEY) {
          return new Response("unauthorized", { status: 401 });
        }
        const url = new URL(request.url);
        const skuId = url.searchParams.get("sku_id") || DEFAULT_SKU;
        const targetQty = Number(url.searchParams.get("qty") ?? "1");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { publishSkuToHqCore, releaseSkuToBranchCore } = await import(
          "@/lib/omnichannel-publish.functions"
        );
        const { runStockSyncWorkerForCron } = await import("@/lib/youzan-sync.functions");

        const steps: Array<{ step: string; ok: boolean; detail?: unknown; error?: string }> = [];
        const record = async <T,>(name: string, fn: () => Promise<T>) => {
          try {
            const detail = await fn();
            steps.push({ step: name, ok: true, detail });
            return detail;
          } catch (e) {
            steps.push({
              step: name,
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            });
            throw e;
          }
        };

        try {
          // 1) HQ 发布（幂等）
          await record("publish_hq", () => publishSkuToHqCore(skuId));

          // 2) release 到中信泰富分店（幂等）
          await record("release_branch", () =>
            releaseSkuToBranchCore(skuId, BRANCH_SHOP_ID),
          );

          // 3) 把该 SKU 在分店库位的库存调整到 targetQty
          //    读当前 qty，算 delta，走 inv_apply_movement（会触发 push_stock 入队）
          await record("adjust_stock", async () => {
            const { data: cur } = await supabaseAdmin
              .from("inv_stocks")
              .select("qty")
              .eq("sku_id", skuId)
              .eq("location_id", BRANCH_LOCATION_ID)
              .maybeSingle();
            const currentQty = (cur as { qty?: number } | null)?.qty ?? 0;
            const delta = targetQty - currentQty;
            if (delta === 0) return { current: currentQty, delta: 0, skipped: true };
            const { data, error } = await supabaseAdmin.rpc("inv_apply_movement", {
              p_sku_id: skuId,
              p_location_id: BRANCH_LOCATION_ID,
              p_delta: delta,
              p_ref_type: "test_publish",
              p_ref_id: undefined,
              p_epc: undefined,
              p_note: "test-publish-with-stock",
            } as never);
            if (error) throw new Error(error.message);
            return { current: currentQty, delta, new_balance: data };
          });

          // 4) 立即跑 stock worker 把队列里的 push_stock 推到有赞
          const workerResult = await record("run_stock_worker", () =>
            runStockSyncWorkerForCron(),
          );

          // 5) 汇总当前状态
          const [{ data: sku }, { data: listings }, { data: queueTail }] = await Promise.all([
            supabaseAdmin
              .from("inv_skus")
              .select("id, name, stock_qty, sales_state, inventory_version")
              .eq("id", skuId)
              .maybeSingle(),
            supabaseAdmin
              .from("sku_channel_listings")
              .select("channel, shop_id, listing_status, external_item_id, last_error, last_verified_at")
              .eq("sku_id", skuId),
            supabaseAdmin
              .from("youzan_stock_sync_queue")
              .select("id, action, status, target_stock, last_error, updated_at")
              .eq("sku_id", skuId)
              .order("updated_at", { ascending: false })
              .limit(5),
          ]);

          return Response.json({
            ok: true,
            sku,
            listings,
            queue_tail: queueTail,
            worker: workerResult,
            steps,
          });
        } catch (e) {
          return Response.json(
            {
              ok: false,
              error: e instanceof Error ? e.message : String(e),
              steps,
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
