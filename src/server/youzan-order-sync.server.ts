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

type CursorRow = {
  id: string;
  shop_id: string;
  window_start: string;
  window_end: string;
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

/** 按天切窗口，避免单窗口页数过多；返回登记的窗口数 */
export async function enqueueOrderSyncWindows(opts: {
  days?: number;
  shop_id?: string;
  windowHours?: number;
}): Promise<{ shops: number; windows: number }> {
  const sb = await admin();
  const days = Math.max(1, Math.min(opts.days ?? 30, 180));
  const windowHours = Math.max(6, Math.min(opts.windowHours ?? 24, 72));

  let q = sb.from("youzan_shops").select("id,role,status").eq("status", "active");
  if (opts.shop_id) q = q.eq("id", opts.shop_id);
  const { data: shops, error } = await q;
  if (error) throw new Error(error.message);

  const rows: Record<string, unknown>[] = [];
  const end = Date.now();
  const spanMs = windowHours * 3_600_000;
  for (const shop of (shops ?? []) as { id: string }[]) {
    for (let cursor = end - days * 86_400_000; cursor < end; cursor += spanMs) {
      rows.push({
        shop_id: shop.id,
        window_start: new Date(cursor).toISOString(),
        window_end: new Date(Math.min(cursor + spanMs, end)).toISOString(),
        status: "pending",
        next_page: 1,
      });
    }
  }
  if (rows.length > 0) {
    const { error: upsertError } = await sb
      .from("youzan_order_sync_cursors")
      .upsert(rows, { onConflict: "shop_id,window_start,window_end", ignoreDuplicates: true });
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
  const leaseSeconds = Math.max(30, Math.min(opts.leaseSeconds ?? 120, 600));
  const { data: claimed, error } = await sb.rpc("youzan_claim_order_sync_cursor", {
    p_worker_id: opts.workerId,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw new Error(error.message);
  const cursor = (Array.isArray(claimed) ? claimed[0] : claimed) as CursorRow | null;
  if (!cursor?.id) return { claimed: false, reason: "idle" };

  try {
    const result = await runOrdersSyncSlice({
      shop_id: cursor.shop_id,
      start: new Date(cursor.window_start),
      end: new Date(cursor.window_end),
      startPage: cursor.next_page,
      maxPages: Math.max(1, Math.min(opts.maxPages ?? 3, 10)),
      methodLabel: cursor.method_label,
    });

    const done = result.next_page === null;
    await sb
      .from("youzan_order_sync_cursors")
      .update({
        status: done ? "done" : "pending",
        next_page: result.next_page ?? cursor.next_page,
        method_label: result.method_label ?? cursor.method_label,
        total_upserted: (cursor.total_upserted ?? 0) + result.count,
        last_error: null,
        lease_owner: null,
        lease_expires_at: null,
        last_progress_at: new Date().toISOString(),
      })
      .eq("id", cursor.id);

    return {
      claimed: true,
      cursor_id: cursor.id,
      shop_id: cursor.shop_id,
      window: [cursor.window_start, cursor.window_end],
      upserted: result.count,
      next_page: result.next_page,
      done,
      message: result.message.slice(0, 600),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sb
      .from("youzan_order_sync_cursors")
      .update({
        status: "error",
        last_error: message.slice(0, 2000),
        lease_owner: null,
        lease_expires_at: null,
      })
      .eq("id", cursor.id);
    return { claimed: true, cursor_id: cursor.id, done: false, error: message.slice(0, 600) };
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
