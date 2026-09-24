/**
 * 手持端智能上架 → 有赞门店发布 outbox worker。
 * 任务由 handheld_smart_create_commit 在建档事务内写入；这里按租约领取、执行、退避重试。
 * 只应在腾讯固定出口环境运行（HANDHELD_RELEASE_WORKER_ENABLED=true），有赞请求仍经 youzanFetch 代理。
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type OutboxRow = {
  id: string;
  sku_id: string;
  shop_id: string;
  location_id: string;
  claim_token: string;
  attempts: number;
};

export type ReleaseDeps = {
  release: (skuId: string, shopId: string) => Promise<{ ok: boolean; results?: unknown }>;
  assignGroups: (skuId: string) => Promise<unknown>;
};

async function defaultDeps(): Promise<ReleaseDeps> {
  const { releaseSkuToOfflineShopsCore } = await import("@/lib/youzan-offline-products.functions");
  const { assignSkuToYouzanCategoryGroups } = await import("@/lib/youzan-category-groups.server");
  return {
    release: (skuId, shopId) => releaseSkuToOfflineShopsCore({ sku_id: skuId, shop_ids: [shopId] }),
    assignGroups: assignSkuToYouzanCategoryGroups,
  };
}

async function finish(row: OutboxRow, ok: boolean, error: string | null, result: unknown, cancel = false) {
  const { data, error: rpcError } = await supabaseAdmin.rpc("handheld_release_outbox_finish" as never, {
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

export async function runHandheldReleaseWorker(limit = 3, deps?: ReleaseDeps) {
  const { data, error } = await supabaseAdmin.rpc("handheld_release_outbox_claim" as never, {
    p_limit: limit,
    p_lease_seconds: 900,
  } as never);
  if (error) throw new Error(`outbox claim failed: ${error.message}`);
  const rows = (data ?? []) as unknown as OutboxRow[];
  const d = rows.length ? (deps ?? (await defaultDeps())) : null;
  const outcomes: Array<{ id: string; status: string }> = [];
  for (const row of rows) {
    try {
      // 已归档/撤销或该库位已无库存的商品不再发布（例如重复孤品已被撤销）。
      const [{ data: sku, error: skuError }, { data: stock, error: stockError }] = await Promise.all([
        supabaseAdmin.from("inv_skus").select("status").eq("id", row.sku_id).maybeSingle(),
        supabaseAdmin
          .from("inv_stocks")
          .select("qty")
          .eq("sku_id", row.sku_id)
          .eq("location_id", row.location_id)
          .maybeSingle(),
      ]);
      if (skuError || stockError) throw new Error(skuError?.message ?? stockError!.message);
      if (!sku || sku.status !== "active" || Number(stock?.qty ?? 0) <= 0) {
        outcomes.push({ id: row.id, status: await finish(row, false, "sku_not_publishable", null, true) });
        continue;
      }
      const release = await d!.release(row.sku_id, row.shop_id);
      if (!release.ok) {
        outcomes.push({
          id: row.id,
          status: await finish(row, false, "release_not_ok", release.results ?? null),
        });
        continue;
      }
      try {
        await d!.assignGroups(row.sku_id);
      } catch (e) {
        console.error("[handheld release worker] 分组归类失败（不影响发布）", e);
      }
      outcomes.push({ id: row.id, status: await finish(row, true, null, release.results ?? null) });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[handheld release worker]", row.id, message);
      outcomes.push({ id: row.id, status: await finish(row, false, message, null) });
    }
  }
  return { claimed: rows.length, outcomes };
}
