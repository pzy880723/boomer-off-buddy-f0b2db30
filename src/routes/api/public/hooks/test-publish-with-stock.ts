// E2E test: publish SKU to HQ, release to CITIC Taifu branch, set stock=qty, push to Youzan.
// POST /api/public/hooks/test-publish-with-stock?sku_id=<uuid>&qty=1
//   header apikey: SUPABASE_PUBLISHABLE_KEY
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

        const summary: Record<string, unknown> = { sku_id: skuId, qty: targetQty };

        try {
          summary.hq_publish = await record("publish_hq", () => publishSkuToHqCore(skuId));
          summary.branch_release = await record("release_branch", () =>
            releaseSkuToBranchCore(skuId, BRANCH_SHOP_ID),
          );

          summary.movement = await record("adjust_stock", async () => {
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
              p_ref_type: "manual_adjust",
              p_ref_id: undefined,
              p_epc: undefined,
              p_note: "test-publish-with-stock",
            } as never);
            if (error) throw new Error(error.message);
            return { current: currentQty, delta, new_balance: data };
          });

          // 重置队列里过去失败的记录，确保 worker 会真的重试
          summary.queue_reset = await record("reset_queue", async () => {
            const { data, error } = await supabaseAdmin
              .from("youzan_stock_sync_queue")
              .update({
                status: "pending",
                attempts: 0,
                next_run_at: new Date().toISOString(),
                last_error: null,
              } as never)
              .eq("sku_id", skuId)
              .in("status", ["failed", "pending"])
              .select("id, status, attempts");
            if (error) throw new Error(error.message);
            return { reset: data?.length ?? 0 };
          });

          summary.worker = await record("run_stock_worker", () => runStockSyncWorkerForCron());

        } catch (e) {
          summary.error = e instanceof Error ? e.message : String(e);
        }

        // Always dump current state, even on partial failure
        const [{ data: sku }, { data: listings }, { data: links }, { data: queueTail }, { data: syncLogsTail }] =
          await Promise.all([
            supabaseAdmin
              .from("inv_skus")
              .select("id, name, sku_code, stock_qty, sales_state, inventory_version")
              .eq("id", skuId)
              .maybeSingle(),
            supabaseAdmin
              .from("sku_channel_listings")
              .select("channel, shop_id, listing_status, external_spu_id, external_item_id, external_sku_id, last_error, last_verified_at")
              .eq("sku_id", skuId),
            supabaseAdmin
              .from("sku_youzan_links")
              .select("shop_id, role, yz_item_id, yz_sku_id, status, sync_stock, last_error, updated_at")
              .eq("sku_id", skuId),
            supabaseAdmin
              .from("youzan_stock_sync_queue")
              .select("id, shop_id, action, status, target_stock, attempts, last_error, updated_at")
              .eq("sku_id", skuId)
              .order("updated_at", { ascending: false })
              .limit(10),
            supabaseAdmin
              .from("youzan_sync_logs")
              .select("action, status, message, error, kdt_id, created_at, finished_at")
              .order("created_at", { ascending: false })
              .limit(20),
          ]);

        summary.sku = sku;
        summary.listings = listings ?? [];
        summary.links = links ?? [];
        summary.queue_tail = queueTail ?? [];
        summary.sync_logs_tail = syncLogsTail ?? [];
        summary.steps = steps;
        summary.ok = !summary.error;

        return Response.json(summary, { status: summary.error ? 500 : 200 });
      },
    },
  },
});
