/**
 * 有赞订单同步：持久游标 + 租约 + 有界分页。
 *
 * 背景：旧实现一次请求里串行拉 3 个接口版本 × 最多 500 页 × 每单库存对账，
 * 超出 Worker 单请求预算被杀，日志里留下一堆 running → 自动重置成 error。
 *
 * 新流程：
 *  1. enqueueOrderSyncWindows —— 为活跃门店登记要同步的时间窗口（幂等）。
 *  2. runOrderSyncSliceOnce —— 领取一个游标（租约保护），只跑少量页，
 *     写回 next_page；跑完标记 done，出错标 error 并自动重试（attempts < 20）。
 */
import { runOrdersSyncSlice } from "@/lib/youzan.functions";
import { buildFixedWindows, classifySliceOutcome } from "@/lib/youzan-sync/cursor";

type CursorRow = {
  id: string;
  shop_id: string;
  window_start: string;
  window_end: string;
  scan_end: string;
  next_page: number;
  method_label: string | null;
  total_upserted: number;
  attempts: number;
};

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  /* eslint-disable @typescript-eslint/no-explicit-any */
  return supabaseAdmin as unknown as {
    from: (t: string) => any;
    rpc: (fn: string, args: Record<string, unknown>) => any;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** 固定窗口登记；DB 原子重开已完成的回溯窗口，不干扰正在分页的扫描。 */
export async function enqueueOrderSyncWindows(opts: {
  days?: number;
  shop_id?: string;
  windowHours?: number;
  now?: Date;
}): Promise<{ shops: number; windows: number }> {
  const sb = await admin();

  let q = sb.from("youzan_shops").select("id,role,status").eq("status", "active");
  if (opts.shop_id) q = q.eq("id", opts.shop_id);
  const { data: shops, error } = await q;
  if (error) throw new Error(error.message);

  const rows = buildFixedWindows({
    shopIds: ((shops ?? []) as { id: string }[]).map((s) => s.id),
    now: opts.now ?? new Date(),
    days: opts.days ?? 30,
    windowHours: opts.windowHours ?? 24,
  });

  if (rows.length > 0) {
    const { error: upsertError } = await sb.rpc("youzan_enqueue_order_sync_windows", { p_windows: rows });
    if (upsertError) throw new Error(upsertError.message);
  }
  return { shops: (shops ?? []).length, windows: rows.length };
}

/** 领取并推进一个游标切片；返回本次结果（没有可做的返回 idle） */
export async function runOrderSyncSliceOnce(opts: {
  workerId: string;
  maxPages?: number;
  leaseSeconds?: number;
}): Promise<Record<string, unknown>> {
  const sb = await admin();
  // Unique per claim, even when one cron request runs several slices (no ABA).
  const leaseOwner = `${opts.workerId}/${crypto.randomUUID()}`;
  const leaseSeconds = Math.max(30, Math.min(opts.leaseSeconds ?? 120, 600));
  const { data: claimed, error } = await sb.rpc("youzan_claim_order_sync_cursor", {
    p_worker_id: leaseOwner,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw new Error(error.message);
  const cursor = (Array.isArray(claimed) ? claimed[0] : claimed) as CursorRow | null;
  if (!cursor?.id) return { claimed: false, reason: "idle" };

  // 领取时 DB 不再自增 attempts；连续失败次数由 classifySliceOutcome 决定
  const previousAttempts = Number(cursor.attempts ?? 0);

  const advance = async (outcome: ReturnType<typeof classifySliceOutcome>, upserted: number) => {
    const { data: applied, error: rpcError } = await sb.rpc("youzan_advance_order_sync_cursor", {
      p_cursor_id: cursor.id,
      p_worker_id: leaseOwner,
      p_status: outcome.status,
      p_next_page: outcome.next_page,
      p_method_label: outcome.method_label,
      p_upserted: upserted,
      p_attempts: outcome.attempts,
      p_error: outcome.reason ? outcome.reason.slice(0, 2000) : null,
    });
    if (rpcError) throw new Error(`cursor_advance_failed: ${rpcError.message}`);
    // 租约已被别的 worker 接管 → 本次结果作废，不能覆盖
    return applied === true;
  };

  try {
    if (!cursor.scan_end || !Number.isFinite(Date.parse(cursor.scan_end))) {
      throw new Error("missing_scan_end: queue migration required");
    }
    const result = await runOrdersSyncSlice({
      shop_id: cursor.shop_id,
      start: new Date(cursor.window_start),
      end: new Date(cursor.scan_end),
      startPage: cursor.next_page,
      maxPages: Math.max(1, Math.min(opts.maxPages ?? 3, 10)),
      methodLabel: cursor.method_label,
      commitRows: async (rows) => {
        const { data, error: commitError } = await sb.rpc("youzan_commit_order_sync_batch", {
          p_cursor_id: cursor.id,
          p_worker_id: leaseOwner,
          p_rows: rows,
        });
        if (commitError) throw new Error(`order_batch_failed: ${commitError.message}`);
        if (!Array.isArray(data) || data.some((key) => typeof key !== "string")) {
          throw new Error("invalid_order_batch_receipt");
        }
        return data as string[];
      },
    });

    const outcome = classifySliceOutcome(result, {
      startPage: cursor.next_page,
      previousAttempts,
    });
    const applied = await advance(
      outcome,
      outcome.status === "error" || outcome.status === "failed" ? 0 : result.count,
    );

    const scanComplete = applied && outcome.status === "done";
    const windowComplete = scanComplete && Date.parse(cursor.scan_end) >= Date.parse(cursor.window_end);
    return {
      claimed: true,
      applied,
      cursor_id: cursor.id,
      shop_id: cursor.shop_id,
      window: [cursor.window_start, cursor.window_end],
      upserted: result.count,
      next_page: scanComplete && !windowComplete ? 1 : outcome.next_page,
      status: !applied ? "lease_lost" : scanComplete && !windowComplete ? "pending" : outcome.status,
      done: windowComplete,
      scan_complete: scanComplete,
      scanned_through: scanComplete ? cursor.scan_end : null,
      empty: outcome.empty,
      message: (outcome.reason ?? result.message).slice(0, 600),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith("cursor_advance_failed")) throw e;
    const outcome = classifySliceOutcome(
      {
        ok: false,
        count: 0,
        message,
        next_page: cursor.next_page,
        method_label: cursor.method_label,
      },
      { startPage: cursor.next_page, previousAttempts },
    );
    const applied = await advance(outcome, 0);
    return {
      claimed: true,
      applied,
      cursor_id: cursor.id,
      status: outcome.status,
      done: false,
      error: message.slice(0, 600),
    };
  }
}

/** 同步进度概览（HQ 页面/验收用） */
export async function orderSyncProgress(): Promise<Record<string, number>> {
  const sb = await admin();
  const { data } = await sb.from("youzan_order_sync_cursors").select("status");
  const counts: Record<string, number> = { pending: 0, running: 0, done: 0, error: 0 };
  for (const row of (data ?? []) as { status: string }[]) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  return counts;
}
