/**
 * 手持端商品修改 → 有赞改价/改名 outbox worker（腾讯固定出口执行）。
 * 任务由 handheld_item_update 在同一事务写入；这里按租约领取、执行、退避重试。
 * 读库失败按普通失败重试，不会误取消任务。
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type Row = { id: string; sku_id: string; shop_id: string; claim_token: string; attempts: number };
type SyncResult = { skipped?: string; price_synced: boolean; name_pending: boolean; remote_item_id?: number };
export type ItemSyncDeps = { sync: (skuId: string, shopId: string) => Promise<SyncResult> };

async function defaultDeps(): Promise<ItemSyncDeps> {
  const { syncSkuInfoToYouzanBranchCore } = await import("@/lib/youzan-offline-products.functions");
  return { sync: (sku_id, shop_id) => syncSkuInfoToYouzanBranchCore({ sku_id, shop_id }) };
}

async function finish(row: Row, ok: boolean, error: string | null, result: unknown, cancel = false) {
  const { data, error: rpcError } = await supabaseAdmin.rpc("handheld_item_sync_outbox_finish" as never, {
    p_id: row.id,
    p_claim_token: row.claim_token,
    p_ok: ok,
    p_error: error,
    p_result: (result ?? null) as never,
    p_cancel: cancel,
  } as never);
  if (rpcError) throw new Error(`outbox finish failed: ${rpcError.message}`);
  return data as unknown as string;
}

export async function runHandheldItemSyncWorker(limit = 3, deps?: ItemSyncDeps) {
  const { data, error } = await supabaseAdmin.rpc("handheld_item_sync_outbox_claim" as never, {
    p_limit: limit,
    p_lease_seconds: 600,
  } as never);
  if (error) throw new Error(`outbox claim failed: ${error.message}`);
  const rows = (data ?? []) as unknown as Row[];
  const d = rows.length ? (deps ?? (await defaultDeps())) : null;
  const outcomes: Array<{ id: string; status: string }> = [];
  for (const row of rows) {
    try {
      const r = await d!.sync(row.sku_id, row.shop_id);
      if (r.skipped) {
        // 商品已归档 / 已取消发布 / 非孤品：不重发布，记录原因后收尾。
        outcomes.push({ id: row.id, status: await finish(row, false, r.skipped, r, true) });
      } else if (r.name_pending) {
        // 改名接口待确认：价格已同步，名称差异留痕，不猜测调用。
        outcomes.push({ id: row.id, status: await finish(row, false, "name_sync_api_unconfirmed", r, true) });
      } else {
        outcomes.push({ id: row.id, status: await finish(row, true, null, r) });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[handheld item sync worker]", row.id, message);
      outcomes.push({ id: row.id, status: await finish(row, false, message, null) });
    }
  }
  return { claimed: rows.length, outcomes };
}
