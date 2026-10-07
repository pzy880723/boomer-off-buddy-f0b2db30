// ============================================================
// 通用渠道同步 Worker
// ------------------------------------------------------------
// 消费 channel_sync_outbox：
//   - 鉴权：仅服务角色 Bearer（腾讯 systemd timer 调用）；公开 apikey 不可触发。
//   - claim_channel_sync_tasks_v2 领取（过期租约可重取；可按 sku_id/action 限定做 canary）。
//   - 清零/下架写有赞前：读取 SKU 版本/sales_state/is_display、任务门店真实 inv_stocks、listing 归属；
//     读取失败 → 不写、进入重试；活跃或有库存的旧任务 → superseded。
//   - 完成一律经 finish_channel_sync_task（worker fencing）；DB 写入失败不报成功。
//   - dead_letter 不计入售出闭环。
// ============================================================
import { createFileRoute } from "@tanstack/react-router";
import {
  callYouzanApiVerbose,
  ensureAccessToken,
  explainYouzanError,
  pushYouzanQuantityUpdate,
} from "@/lib/youzan.functions";
import { buildBranchItemShelfRequest } from "@/lib/youzan-offline-products.server";
import { verifyListingCore } from "@/lib/omnichannel-publish.functions";
import { canMarkSold, evaluateZeroingTask, isServiceBearer, ZEROING_ACTIONS } from "@/lib/channel-sync-guard";

const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_LIMIT = 20;
const BACKOFF_STEPS_MS = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

class TaskBlocked extends Error {}

export const Route = createFileRoute("/api/public/hooks/channel-sync-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isServiceBearer(request.headers.get("authorization"), process.env.SUPABASE_SERVICE_ROLE_KEY ?? "")) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        let body: { limit?: number; lease_seconds?: number; worker_id?: string; sku_id?: string; action?: string } = {};
        try { body = (await request.json()) as typeof body; } catch { /* empty body ok */ }
        if (body.sku_id !== undefined && !UUID_RE.test(String(body.sku_id))) return Response.json({ error: "invalid sku_id" }, { status: 400 });
        if (body.action !== undefined && !/^[a-z_]{1,40}$/.test(String(body.action))) return Response.json({ error: "invalid action" }, { status: 400 });

        const workerId = (typeof body.worker_id === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(body.worker_id) ? body.worker_id : null)
          ?? `w-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
        const limit = Math.max(1, Math.min(100, body.limit ?? DEFAULT_LIMIT));
        const leaseSeconds = Math.max(15, Math.min(300, body.lease_seconds ?? DEFAULT_LEASE_SECONDS));

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: tasks, error } = await supabaseAdmin.rpc("claim_channel_sync_tasks_v2", {
          p_worker_id: workerId, p_limit: limit, p_lease_seconds: leaseSeconds,
          p_sku_id: body.sku_id ?? undefined, p_action: body.action ?? undefined,
        } as never);
        if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
        const list = (tasks as OutboxTask[] | null) ?? [];
        const results: Array<{ id: string; action: string; ok: boolean; status: string; error?: string }> = [];

        const finish = async (task: OutboxTask, status: string, err: string | null, nextRunAt?: string) => {
          const { data, error: e } = await supabaseAdmin.rpc("finish_channel_sync_task", {
            p_id: task.id, p_worker_id: workerId, p_status: status, p_error: err ?? undefined, p_next_run_at: nextRunAt ?? undefined,
          } as never);
          if (e) throw new Error(`完成写入失败：${e.message}`);
          if (data !== true) throw new Error("租约已失效（被其他 worker 接管），结果未写入");
        };

        for (const task of list) {
          try {
            if (ZEROING_ACTIONS.has(task.action)) {
              const v = evaluateZeroingTask(task, await loadZeroingFacts(task, supabaseAdmin));
              if (v.verdict === "supersede") {
                await finish(task, "superseded", `superseded: ${v.reason}`);
                results.push({ id: task.id, action: task.action, ok: true, status: "superseded", error: v.reason });
                continue;
              }
              if (v.verdict === "block") throw new TaskBlocked(v.reason);
            } else if ((task.action === "set_stock" || task.action === "restore_after_return") && task.inventory_version > 0) {
              const { data: s, error: se } = await supabaseAdmin.from("inv_skus").select("inventory_version").eq("id", task.sku_id).maybeSingle();
              if (se || !s) throw new TaskBlocked("sku 读取失败");
              const cur = Number((s as { inventory_version: number }).inventory_version);
              if (cur > task.inventory_version) {
                await finish(task, "superseded", `superseded: sku inventory_version=${cur} > task ${task.inventory_version}`);
                results.push({ id: task.id, action: task.action, ok: true, status: "superseded" });
                continue;
              }
            }

            await dispatch(task, supabaseAdmin);
            await finish(task, "succeeded", null);
            if (ZEROING_ACTIONS.has(task.action)) await maybeMarkSold(task.sku_id, supabaseAdmin);
            if (task.action === "restore_after_return") {
              const { error: ue } = await supabaseAdmin.from("inv_skus")
                .update({ sales_state: "active", updated_at: new Date().toISOString() } as never).eq("id", task.sku_id);
              if (ue) throw new Error(`回补状态写入失败：${ue.message}`);
            }
            if (task.channel_listing_id && task.inventory_version > 0 &&
                (task.action === "set_stock" || task.action === "set_stock_zero" || task.action === "restore_after_return")) {
              const { error: le } = await supabaseAdmin.from("sku_channel_listings")
                .update({ verified_inventory_version: task.inventory_version, updated_at: new Date().toISOString() } as never)
                .eq("id", task.channel_listing_id);
              if (le) throw new Error(`listing 版本写入失败：${le.message}`);
            }
            results.push({ id: task.id, action: task.action, ok: true, status: "succeeded" });
          } catch (e) {
            const msg = e instanceof TaskBlocked ? `blocked: ${e.message}` : explainYouzanError(e);
            const attempts = task.attempts ?? 0;
            const dead = attempts >= task.max_attempts;
            const backoff = BACKOFF_STEPS_MS[Math.min(attempts, BACKOFF_STEPS_MS.length - 1)];
            let status = dead ? "dead_letter" : "retry_wait";
            try {
              // 若已 succeeded 后的后续写失败，fencing 会返回 false（状态不再是 running）→ 如实报告失败。
              await finish(task, status, msg, new Date(Date.now() + backoff).toISOString());
            } catch (fe) {
              status = "unrecorded";
              console.error("[channel-sync-worker] finish failed", task.id, fe);
            }
            results.push({ id: task.id, action: task.action, ok: false, status, error: msg.slice(0, 200) });
          }
        }

        const failed = results.filter((r) => !r.ok).length;
        return Response.json({ ok: failed === 0, worker_id: workerId, claimed: list.length, failed, results });
      },
    },
  },
});

async function loadZeroingFacts(task: OutboxTask, sb: Admin) {
  const [skuR, listingR, locR] = await Promise.all([
    sb.from("inv_skus").select("inventory_version, sales_state, is_display").eq("id", task.sku_id).maybeSingle(),
    task.channel_listing_id
      ? sb.from("sku_channel_listings").select("sku_id, shop_id").eq("id", task.channel_listing_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    task.shop_id ? sb.from("inv_locations").select("id").eq("shop_id", task.shop_id) : Promise.resolve({ data: [], error: null }),
  ]);
  let stockQty: number | null = null;
  const locs = (locR.data ?? []) as { id: string }[];
  if (!locR.error && locs.length === 1) {
    const st = await sb.from("inv_stocks").select("qty").eq("sku_id", task.sku_id).eq("location_id", locs[0].id).maybeSingle();
    if (!st.error) stockQty = Number((st.data as { qty?: number } | null)?.qty ?? 0);
  }
  return {
    sku: skuR.error ? null : (skuR.data as { inventory_version: number; sales_state: string | null; is_display: boolean | null } | null),
    stockQty,
    listing: listingR.error ? null : (listingR.data as { sku_id: string; shop_id: string | null } | null),
  };
}

// 售出闭环：清零与下架均成功、无未完成或 dead_letter 任务、sku 仍 sold_syncing 且库存 0。
async function maybeMarkSold(skuId: string, sb: Admin) {
  const { data: tasks, error } = await sb.from("channel_sync_outbox").select("action, status").eq("sku_id", skuId)
    .in("action", ["set_stock_zero", "delist"]);
  if (error) throw new Error(`读取售出任务失败：${error.message}`);
  if (!canMarkSold((tasks ?? []) as { action: string; status: string }[])) return;
  const { error: ue } = await sb.from("inv_skus")
    .update({ sales_state: "sold", updated_at: new Date().toISOString() } as never)
    .eq("id", skuId).eq("sales_state", "sold_syncing").lte("stock_qty", 0);
  if (ue) throw new Error(`售出状态写入失败：${ue.message}`);
}

// ============================================================
// 分派：每个 action 一个 handler
// ============================================================
async function dispatch(
  task: OutboxTask,
  sb: Admin,
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
  sb: Admin,
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
  if (l.channel !== "youzan_branch_offline") {
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
  // 只推分店线下门店销售库存（channel=1）；网店由 ERP 自研，不再往有赞网店同步
  // 严格禁止 item_id == HQ SPU id：allowSameAsHqSpu 已下线；如触发说明 listing 未 verify 到真实分店 id
  await pushYouzanQuantityUpdate({
    branchShop: branch as unknown as Parameters<typeof pushYouzanQuantityUpdate>[0]["branchShop"],
    itemId,
    skuId: skuId || itemId,
    quantity: target,
    hqSpuIdGuard,
    channel: 1,
  });




  const { error: wErr } = await sb
    .from("sku_channel_listings")
    .update({
      last_stock: target,
      last_stock_pushed: target,
      last_pushed_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("id", task.channel_listing_id);
  if (wErr) throw new Error(`库存推送结果写入失败：${wErr.message}`);
}

// --- 上下架 ---------------------------------------------------
async function handleShelfChange(
  task: OutboxTask,
  sb: Admin,
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
    .select("*")
    .eq("id", l.shop_id)
    .maybeSingle();
  if (!branch) throw new Error("门店不存在");
  const branchToken = await ensureAccessToken(
    branch as unknown as Parameters<typeof ensureAccessToken>[0],
  );
  const request = buildBranchItemShelfRequest({
    itemId: Number(l.external_item_id),
    online,
  });
  await callYouzanApiVerbose({
    accessToken: branchToken,
    ...request,
    timeoutMs: 20_000,
  });
  const { error: sErr } = await sb
    .from("sku_channel_listings")
    .update({
      listing_status: online ? "published" : "unshelved",
      last_error: null,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("id", task.channel_listing_id);
  if (sErr) throw new Error(`上下架结果写入失败：${sErr.message}`);
}

// --- 退货复检后回补 --------------------------------------------
async function handleRestoreAfterReturn(
  task: OutboxTask,
  sb: Admin,
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
  sb: Admin,
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
  if (l.channel !== "youzan_branch_offline" || !l.shop_id || !l.external_item_id) return;
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
