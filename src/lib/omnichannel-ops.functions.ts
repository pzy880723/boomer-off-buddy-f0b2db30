// ============================================================
// 阶段 6 · 退货复检 + 阶段 8 · 异常中心 —— 后端 server functions
// ------------------------------------------------------------
// return_inspections：列表 / 详情 / 完成复检（通过 → 回补 + 重上架）
// channel_sync_outbox：列表 / 手动重放 / 丢弃
// inventory_sale_events：列表 / 手动补匹配（改 sku_id 并重新入队）
// ============================================================
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// -----------------------------------------------------------
// 退货复检
// -----------------------------------------------------------
export const listReturnInspections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        status: z.enum(["pending", "pass", "fail", "all"]).default("pending"),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    let q = supabase
      .from("return_inspections")
      .select(
        "id, sku_id, epc, refund_source_channel, refund_source_order_id, refund_status, physical_status, inspection_result, restock_location_id, channel_restore_status, notes, created_at, completed_at",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.status === "pending") q = q.is("inspection_result", null);
    else if (data.status === "pass") q = q.eq("inspection_result", "pass");
    else if (data.status === "fail") q = q.eq("inspection_result", "fail");
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const skuIds = Array.from(new Set((rows ?? []).map((r) => r.sku_id).filter(Boolean)));
    const { data: skus } = skuIds.length
      ? await supabase.from("inv_skus").select("id, sku_code, name, image_url").in("id", skuIds)
      : { data: [] as Array<{ id: string; sku_code: string; name: string; image_url: string | null }> };
    const map = new Map((skus ?? []).map((s) => [s.id, s]));
    return {
      items: (rows ?? []).map((r) => ({
        ...r,
        sku: map.get(r.sku_id) ?? null,
      })),
    };
  });

export const completeReturnInspection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        inspection_id: z.string().uuid(),
        result: z.enum(["pass", "fail"]),
        location_id: z.string().uuid().optional(),
        notes: z.string().max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    if (data.result === "fail") {
      const { error } = await supabase
        .from("return_inspections")
        .update({
          inspection_result: "fail",
          physical_status: "damaged",
          channel_restore_status: "skipped",
          completed_at: new Date().toISOString(),
          notes: data.notes ?? undefined,
        } as never)
        .eq("id", data.inspection_id);
      if (error) throw new Error(error.message);
      return { ok: true, result: "fail" as const };
    }
    if (!data.location_id) throw new Error("复检通过必须选回补库位");
    const { data: rpc, error } = await supabase.rpc("restore_after_return_inspection", {
      p_inspection_id: data.inspection_id,
      p_location_id: data.location_id,
      p_notes: data.notes ?? undefined,
    });
    if (error) throw new Error(error.message);
    return { ok: true, result: "pass" as const, rpc };
  });

// -----------------------------------------------------------
// 异常中心 · 同步队列
// -----------------------------------------------------------
export const listChannelSyncOutbox = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        status: z
          .enum([
            "pending",
            "running",
            "retry_wait",
            "dead_letter",
            "superseded",
            "cancelled",
            "succeeded",
            "failed", // 语义聚合：retry_wait + dead_letter
            "all",
          ])
          .default("failed"),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    let q = supabase
      .from("channel_sync_outbox")
      .select(
        "id, sku_id, channel, shop_id, action, status, attempts, max_attempts, next_run_at, last_error, target_stock, inventory_version, priority, created_at, updated_at",
      )
      .order("updated_at", { ascending: false })
      .limit(data.limit);
    if (data.status === "failed") q = q.in("status", ["retry_wait", "dead_letter"]);
    else if (data.status !== "all") q = q.eq("status", data.status);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const skuIds = Array.from(new Set((rows ?? []).map((r) => r.sku_id)));
    const { data: skus } = skuIds.length
      ? await supabase.from("inv_skus").select("id, sku_code, name").in("id", skuIds)
      : { data: [] as Array<{ id: string; sku_code: string; name: string }> };
    const map = new Map((skus ?? []).map((s) => [s.id, s]));
    return {
      items: (rows ?? []).map((r) => ({
        ...r,
        sku: map.get(r.sku_id) ?? null,
      })),
    };
  });

export const retryChannelSyncTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { error } = await supabase
      .from("channel_sync_outbox")
      .update({
        status: "pending",
        next_run_at: new Date().toISOString(),
        lease_expires_at: null,
        worker_id: null,
        last_error: null,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const dismissChannelSyncTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { error } = await supabase
      .from("channel_sync_outbox")
      .update({
        status: "succeeded",
        completed_at: new Date().toISOString(),
        last_error: "manually dismissed",
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// -----------------------------------------------------------
// 异常中心 · 销售事件
// -----------------------------------------------------------
export const listSaleEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        status: z
          .enum(["received", "processed", "unmatched", "oversold", "failed", "all"])
          .default("unmatched"),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    let q = supabase
      .from("inventory_sale_events")
      .select(
        "id, source_channel, source_shop_id, source_order_id, event_type, sku_id, status, error, received_at, processed_at",
      )
      .order("received_at", { ascending: false })
      .limit(data.limit);
    if (data.status !== "all") q = q.eq("status", data.status);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { items: rows ?? [] };
  });

export const rematchSaleEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        event_id: z.string().uuid(),
        sku_id: z.string().uuid(),
        location_id: z.string().uuid().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    // 找到原事件
    const { data: ev } = await supabase
      .from("inventory_sale_events")
      .select("source_channel, source_order_id, event_type, source_shop_id, epc, raw_payload")
      .eq("id", data.event_id)
      .maybeSingle();
    if (!ev) throw new Error("事件不存在");
    // 删掉旧记录（RPC 会重新按 dedupe 插）
    await supabase.from("inventory_sale_events").delete().eq("id", data.event_id);
    const { data: rpc, error } = await supabase.rpc("commit_sale", {
      p_sku_id: data.sku_id,
      p_source_channel: (ev as { source_channel: string }).source_channel,
      p_source_order_id: (ev as { source_order_id: string }).source_order_id,
      p_source_shop_id: (ev as { source_shop_id: string | null }).source_shop_id ?? undefined,
      p_event_type: (ev as { event_type: string }).event_type,
      p_epc: (ev as { epc: string | null }).epc ?? undefined,
      p_location_id: data.location_id ?? undefined,
      p_raw_payload: ((ev as { raw_payload: unknown }).raw_payload ?? {}) as never,
    });
    if (error) throw new Error(error.message);
    return { ok: true, rpc };
  });
