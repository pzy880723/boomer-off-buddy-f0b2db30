// ============================================================
// 通用渠道同步 Worker（阶段 3 + 7）
// ------------------------------------------------------------
// 消费 channel_sync_outbox：
//   - claim_channel_sync_tasks(worker_id, limit, lease_seconds) 抢租约
//   - 根据 action 分派到 handler，全部走【分店 token + youzan.item.quantity.update/4.0.0】
//     或 spu.update / product.online.offline 等
//   - 成功 → status=succeeded；失败 → attempts++、指数退避、达上限进 dead
//
// 触发方式：
//   - pg_cron 每分钟 POST 一次（本文件路径）
//   - 手动运行时可直接 curl，无需登录（/api/public/* 前缀免鉴权）
//
// 安全：/api/public/* 免鉴权，用 apikey header 做最小校验（sb_publishable）
// ============================================================
import { createFileRoute } from "@tanstack/react-router";
import {
  callYouzanApiVerbose,
  ensureAccessToken,
  explainYouzanError,
  getHqShop,
  pushYouzanQuantityUpdate,
} from "@/lib/youzan.functions";
import { verifyListingCore } from "@/lib/omnichannel-publish.functions";

const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_LIMIT = 20;
const BACKOFF_STEPS_MS = [
  5_000, // 5s
  15_000, // 15s
  60_000, // 1m
  5 * 60_000, // 5m
  15 * 60_000, // 15m
  60 * 60_000, // 1h
];

type OutboxTask = {
  id: string;
  sku_id: string;
  channel_listing_id: string | null;
  channel: string;
  shop_id: string | null;
  action: string;
  target_stock: number | null;
  attempts: number;
  max_attempts: number;
  inventory_version: number;
  request_payload: Record<string, unknown>;
};

export const Route = createFileRoute("/api/public/hooks/channel-sync-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // 轻量鉴权：只接受带 apikey 的调用（pg_cron/内部）
        const apikey = request.headers.get("apikey") ?? "";
        const expected = process.env.SUPABASE_ANON_KEY ?? "";
        if (expected && apikey && apikey !== expected) {
          return new Response(JSON.stringify({ error: "invalid apikey" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        let body: { limit?: number; lease_seconds?: number; worker_id?: string } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty body ok */
        }

        const workerId =
          body.worker_id ??
          `cron-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const limit = Math.max(1, Math.min(100, body.limit ?? DEFAULT_LIMIT));
        const leaseSeconds = Math.max(15, Math.min(300, body.lease_seconds ?? DEFAULT_LEASE_SECONDS));

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: tasks, error } = await supabaseAdmin.rpc("claim_channel_sync_tasks", {
          p_worker_id: workerId,
          p_limit: limit,
          p_lease_seconds: leaseSeconds,
        });
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }
        const list = (tasks as OutboxTask[] | null) ?? [];
        const results: Array<{ id: string; action: string; ok: boolean; error?: string }> = [];

        for (const task of list) {
          try {
            await dispatch(task, supabaseAdmin);
            await supabaseAdmin
              .from("channel_sync_outbox")
              .update({
                status: "succeeded",
                completed_at: new Date().toISOString(),
                last_error: null,
                updated_at: new Date().toISOString(),
              } as never)
              .eq("id", task.id);
            // 售出闭环：set_stock_zero + delist 均成功 → sales_state=sold
            if (task.action === "delist" || task.action === "set_stock_zero") {
              await maybeMarkSold(task.sku_id, supabaseAdmin);
            }
            // 回补闭环：restore_after_return 成功 → sales_state=active
            if (task.action === "restore_after_return") {
              await supabaseAdmin
                .from("inv_skus")
                .update({ sales_state: "active", updated_at: new Date().toISOString() } as never)
                .eq("id", task.sku_id);
            }
            results.push({ id: task.id, action: task.action, ok: true });
          } catch (e) {
            const msg = explainYouzanError(e);
            const attempts = task.attempts ?? 0;
            const dead = attempts >= task.max_attempts;
            const backoff = BACKOFF_STEPS_MS[Math.min(attempts, BACKOFF_STEPS_MS.length - 1)];
            await supabaseAdmin
              .from("channel_sync_outbox")
              .update({
                status: dead ? "dead_letter" : "retry_wait",
                last_error: msg.slice(0, 500),
                next_run_at: new Date(Date.now() + backoff).toISOString(),
                lease_expires_at: null,
                updated_at: new Date().toISOString(),
              } as never)
              .eq("id", task.id);
            results.push({ id: task.id, action: task.action, ok: false, error: msg.slice(0, 200) });
          }
        }

        return Response.json({
          ok: true,
          worker_id: workerId,
          claimed: list.length,
          results,
        });
      },
    },
  },
});

// 售出闭环：当 sku 的所有 published/shelved listing 的 set_stock_zero + delist 都已 succeeded，
// 且没有还在跑的相关任务 → 把 sales_state 从 sold_syncing 落到 sold。
async function maybeMarkSold(
  skuId: string,
  sb: Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"],
) {
  const { data: pending } = await sb
    .from("channel_sync_outbox")
    .select("id")
    .eq("sku_id", skuId)
    .in("action", ["set_stock_zero", "delist"])
    .in("status", ["pending", "running", "retry_wait"])
    .limit(1);
  if (pending && pending.length > 0) return;
  const { data: sku } = await sb
    .from("inv_skus")
    .select("sales_state, stock_qty")
    .eq("id", skuId)
    .maybeSingle();
  const s = sku as { sales_state?: string; stock_qty?: number } | null;
  if (!s) return;
  if (s.sales_state === "sold_syncing" && (s.stock_qty ?? 0) <= 0) {
    await sb
      .from("inv_skus")
      .update({ sales_state: "sold", updated_at: new Date().toISOString() } as never)
      .eq("id", skuId);
  }
}

// ============================================================
// 分派：每个 action 一个 handler
// ============================================================
async function dispatch(
  task: OutboxTask,
  sb: Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"],
) {
  switch (task.action) {
    case "set_stock":
    case "set_stock_zero":
      return handleSetStock(task, sb);
    case "delist":
      return handleShelfChange(task, sb, false);
    case "shelf":
      return handleShelfChange(task, sb, true);
    case "verify_listing":
      if (!task.channel_listing_id) return;
      await verifyListingCore(task.channel_listing_id);
      return;
    case "restore_after_return":
      return handleRestoreAfterReturn(task, sb);
    case "reconcile":
      return handleReconcile(task, sb);
    case "create_hq_spu":
    case "publish_offline":
    case "publish_online":
      // 发布链路由 UI/手动触发；worker 侧只做 verify 兜底
      if (task.channel_listing_id) await verifyListingCore(task.channel_listing_id);
      return;
    case "verify_stock":
      return handleReconcile(task, sb);
    default:
      throw new Error(`未知 action：${task.action}`);
  }
}

// --- 库存推送 --------------------------------------------------
async function handleSetStock(
  task: OutboxTask,
  sb: Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"],
) {
  const target = Math.max(0, task.target_stock ?? 0);
  if (!task.channel_listing_id) throw new Error("缺少 channel_listing_id");
  const { data: listing } = await sb
    .from("sku_channel_listings")
    .select("*")
    .eq("id", task.channel_listing_id)
    .maybeSingle();
  if (!listing) throw new Error("listing 已删除");
  const l = listing as {
    channel: string;
    shop_id: string | null;
    external_item_id: string | null;
    external_sku_id: string | null;
    external_spu_id: string | null;
  };
  if (l.channel !== "youzan_offline") {
    // HQ/online 目前不推库存（HQ SPU 不参与直销），跳过
    return;
  }
  if (!l.shop_id) throw new Error("分店 listing 缺 shop_id");

  // 未 verify → 先 verify
  let itemId = Number(l.external_item_id ?? 0);
  let skuId = Number(l.external_sku_id ?? 0);
  if (!itemId) {
    if (!task.channel_listing_id) throw new Error("缺 listing id");
    await verifyListingCore(task.channel_listing_id);
    const { data: refreshed } = await sb
      .from("sku_channel_listings")
      .select("external_item_id, external_sku_id")
      .eq("id", task.channel_listing_id)
      .maybeSingle();
    itemId = Number((refreshed as { external_item_id?: string } | null)?.external_item_id ?? 0);
    skuId = Number((refreshed as { external_sku_id?: string } | null)?.external_sku_id ?? 0);
    if (!itemId) throw new Error("verify 未获得 item_id");
  }

  const { data: branch } = await sb
    .from("youzan_shops")
    .select("*")
    .eq("id", l.shop_id)
    .maybeSingle();
  if (!branch) throw new Error("门店不存在");
  const hqSpuIdGuard = Number(l.external_spu_id ?? 0) || undefined;
  // 分店同时推 offline(channel=1) 与 online(channel=0) 两种销售库存
  const channels: Array<0 | 1> = [1, 0];
  const pushErrors: string[] = [];
  for (const ch of channels) {
    try {
      await pushYouzanQuantityUpdate({
        branchShop: branch as unknown as Parameters<typeof pushYouzanQuantityUpdate>[0]["branchShop"],
        itemId,
        skuId: skuId || itemId,
        quantity: target,
        hqSpuIdGuard,
        allowSameAsHqSpu: true,
        channel: ch,
      });
    } catch (e) {
      pushErrors.push(`channel=${ch}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (pushErrors.length === channels.length) {
    throw new Error(pushErrors.join(" | "));
  }


  await sb
    .from("sku_channel_listings")
    .update({
      last_stock: target,
      last_stock_pushed: target,
      last_pushed_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("id", task.channel_listing_id);
}

// --- 上下架 ---------------------------------------------------
async function handleShelfChange(
  task: OutboxTask,
  sb: Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"],
  online: boolean,
) {
  if (!task.channel_listing_id) throw new Error("缺 channel_listing_id");
  const { data: listing } = await sb
    .from("sku_channel_listings")
    .select("*")
    .eq("id", task.channel_listing_id)
    .maybeSingle();
  if (!listing) throw new Error("listing 已删除");
  const l = listing as {
    shop_id: string | null;
    external_item_id: string | null;
  };
  if (!l.shop_id || !l.external_item_id) throw new Error("listing 未 verify");
  const { data: branch } = await sb
    .from("youzan_shops")
    .select("kdt_id")
    .eq("id", l.shop_id)
    .maybeSingle();
  if (!branch) throw new Error("门店不存在");
  const hq = await getHqShop();
  const hqToken = await ensureAccessToken(hq);
  await callYouzanApiVerbose({
    accessToken: hqToken,
    method: online
      ? "youzan.retail.open.product.online"
      : "youzan.retail.open.product.offline",
    version: "1.0.0",
    params: {
      kdt_id: Number((branch as { kdt_id: number }).kdt_id),
      item_id: Number(l.external_item_id),
    },
    timeoutMs: 20_000,
  });
  await sb
    .from("sku_channel_listings")
    .update({
      listing_status: online ? "published" : "unshelved",
      last_error: null,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("id", task.channel_listing_id);
}

// --- 退货复检后回补 --------------------------------------------
async function handleRestoreAfterReturn(
  task: OutboxTask,
  sb: Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"],
) {
  // HQ 侧不参与直销，跳过（restore RPC 会为所有 listing 建任务）
  if (task.channel === "youzan_hq" || !task.shop_id) return;
  // 回补 = 上架 + 覆盖库存到 1（单件模型）
  await handleShelfChange(task, sb, true);
  const t2 = { ...task, target_stock: task.target_stock ?? 1 } as OutboxTask;
  await handleSetStock(t2, sb);
}

// --- 对账 -----------------------------------------------------
async function handleReconcile(
  task: OutboxTask,
  sb: Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"],
) {
  if (!task.channel_listing_id) return;
  await verifyListingCore(task.channel_listing_id);
  // 拉分店库存和本地对比（简版：不一致时 enqueue set_stock）
  const { data: listing } = await sb
    .from("sku_channel_listings")
    .select("*")
    .eq("id", task.channel_listing_id)
    .maybeSingle();
  if (!listing) return;
  const l = listing as {
    sku_id: string;
    channel: string;
    shop_id: string | null;
    external_item_id: string | null;
    external_sku_id: string | null;
  };
  if (l.channel !== "youzan_offline" || !l.shop_id || !l.external_item_id) return;
  const { data: sku } = await sb
    .from("inv_skus")
    .select("stock_qty, inventory_version")
    .eq("id", l.sku_id)
    .maybeSingle();
  const localStock = Number((sku as { stock_qty?: number } | null)?.stock_qty ?? 0);
  const dedupe = `${l.sku_id}:${task.channel_listing_id}:reconcile:${Number((sku as { inventory_version?: number } | null)?.inventory_version ?? 0)}`;
  await sb
    .from("channel_sync_outbox")
    .upsert(
      {
        sku_id: l.sku_id,
        channel_listing_id: task.channel_listing_id,
        channel: l.channel,
        shop_id: l.shop_id,
        action: "set_stock",
        priority: 5,
        target_stock: localStock,
        dedupe_key: dedupe,
        inventory_version: Number((sku as { inventory_version?: number } | null)?.inventory_version ?? 0),
      } as never,
      { onConflict: "dedupe_key" },
    );
}
