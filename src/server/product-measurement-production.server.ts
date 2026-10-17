/**
 * product-measurement 的 Supabase 生产实现。
 * 申请/保存走事务化 RPC（measurement_request / measurement_save，sku 行锁串行、
 * client_op_id 幂等、通知原子）；全部走 service_role，调用方必须先完成身份与门店权限校验。
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type {
  MeasurementAssetRow,
  MeasurementListingRow,
  MeasurementSkuRow,
  MeasurementTaskRow,
  MeasurementValues,
} from "./product-measurement.server";

const SKU_MEASUREMENT_SELECT =
  "id, location_id, measurement_height_cm, measurement_width_cm, measurement_depth_cm, measurement_diameter_cm, measured_by, measured_at, measurement_revision";

export type MeasurementSkuFull = MeasurementSkuRow & {
  measurement_height_cm: number | null;
  measurement_width_cm: number | null;
  measurement_depth_cm: number | null;
  measurement_diameter_cm: number | null;
};

export async function loadMeasurementSku(id: string): Promise<MeasurementSkuFull | null> {
  const { data, error } = await supabaseAdmin
    .from("inv_skus")
    .select(SKU_MEASUREMENT_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as MeasurementSkuFull | null) ?? null;
}

export async function loadMeasurementListing(id: string): Promise<MeasurementListingRow | null> {
  const { data, error } = await supabaseAdmin
    .from("commerce_listings" as never)
    .select("id, sku_id, location_id, status, published_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as MeasurementListingRow | null) ?? null;
}

/** 顾客申请测量（事务 RPC：合并任务 + 申请者 + 门店手持提醒原子完成） */
export async function requestMeasurementProduction(
  listingId: string,
  customerId: string,
): Promise<{
  status: "pending" | "completed";
  task_id: string | null;
  requested_at: string | null;
  measurement?: {
    height_cm: number | null;
    width_cm: number | null;
    depth_cm: number | null;
    diameter_cm: number | null;
    measured_at: string;
    revision: number;
  } | null;
}> {
  const { data, error } = await supabaseAdmin.rpc("measurement_request" as never, {
    p_listing_id: listingId,
    p_customer_id: customerId,
  } as never);
  if (error) {
    if (error.message.includes("not_found")) throw new Error("not_found");
    throw new Error(error.message);
  }
  return data as never;
}

/**
 * 保存实测（事务 RPC：sku 行锁内做 op 幂等回放/指纹校验、版本 CAS、
 * 当前门店归属校验、锁内查活跃任务、完成任务 + 通知申请者原子完成）。
 */
export async function saveMeasurementProduction(args: {
  skuId: string;
  taskId: string | null;
  actorId: string;
  clientOpId: string;
  expectedRevision: number;
  locationId: string;
  value: MeasurementValues;
}): Promise<{ revision: number; task_id: string | null; notified: number; replayed: boolean }> {
  const { data, error } = await supabaseAdmin.rpc("measurement_save" as never, {
    p_sku_id: args.skuId,
    p_task_id: args.taskId,
    p_actor_id: args.actorId,
    p_client_op_id: args.clientOpId,
    p_expected_revision: args.expectedRevision,
    p_location_id: args.locationId,
    p_height: args.value.height_cm,
    p_width: args.value.width_cm,
    p_depth: args.value.depth_cm,
    p_diameter: args.value.diameter_cm,
  } as never);
  if (error) {
    for (const code of [
      "revision_conflict",
      "op_conflict",
      "location_mismatch",
      "not_found",
      "invalid_measurement",
      "empty_measurement",
      "expected_revision_required",
      "client_op_id_required",
    ]) {
      if (error.message.includes(code)) throw new Error(code);
    }
    throw new Error(error.message);
  }
  return data as never;
}

/** 领取任务：UPDATE ... select 核对受影响行，竞态失败不报假成功 */
export async function claimTaskProduction(
  taskId: string,
  actorId: string,
): Promise<MeasurementTaskRow> {
  const { data: current, error: readError } = await supabaseAdmin
    .from("product_measurement_tasks" as never)
    .select("*")
    .eq("id", taskId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  const row = current as unknown as MeasurementTaskRow | null;
  if (!row || row.status === "completed" || row.status === "cancelled") throw new Error("not_found");
  if (row.status === "claimed" && row.claimed_by && row.claimed_by !== actorId) {
    throw new Error("already_claimed");
  }
  const { data, error } = await supabaseAdmin
    .from("product_measurement_tasks" as never)
    .update({
      status: "claimed",
      claimed_by: actorId,
      claimed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as never)
    .eq("id", taskId)
    .eq("status", "pending")
    .select("id");
  if (error) throw new Error(error.message);
  if (!data || (data as unknown[]).length === 0) {
    // 已被并发领取：回读确认归属
    const { data: after } = await supabaseAdmin
      .from("product_measurement_tasks" as never)
      .select("claimed_by")
      .eq("id", taskId)
      .maybeSingle();
    const claimedBy = (after as unknown as { claimed_by: string | null } | null)?.claimed_by;
    if (claimedBy === actorId) return { ...row, status: "claimed", claimed_by: actorId };
    throw new Error("already_claimed");
  }
  return { ...row, status: "claimed", claimed_by: actorId };
}

export async function findActiveTaskProduction(skuId: string): Promise<MeasurementTaskRow | null> {
  const { data, error } = await supabaseAdmin
    .from("product_measurement_tasks" as never)
    .select("*")
    .eq("sku_id", skuId)
    .in("status", ["pending", "claimed"])
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as MeasurementTaskRow | null) ?? null;
}

export type MeasurementTaskListRow = MeasurementTaskRow & {
  sku_name: string | null;
  location_name: string | null;
  requester_count: number;
  measurement_revision: number;
};

/** 待办列表：默认 pending+claimed 都返回（claimed 不从页面消失） */
export async function listMeasurementTasksProduction(args: {
  locationIds: string[] | null; // null = 总部全量
  statuses?: Array<"pending" | "claimed" | "completed">;
}): Promise<MeasurementTaskListRow[]> {
  const statuses = args.statuses ?? ["pending", "claimed"];
  let query = supabaseAdmin
    .from("product_measurement_tasks" as never)
    .select(
      "*, sku:inv_skus(name, measurement_revision), location:inv_locations(name), requesters:product_measurement_requesters(count)",
    )
    .in("status", statuses)
    .order("created_at", { ascending: false })
    .limit(200);
  if (args.locationIds) query = query.in("location_id", args.locationIds);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (
    (data as unknown as Array<
      MeasurementTaskRow & {
        sku: { name: string; measurement_revision: number } | null;
        location: { name: string } | null;
        requesters: Array<{ count: number }> | null;
      }
    >) ?? []
  ).map((row) => ({
    ...row,
    sku_name: row.sku?.name ?? null,
    location_name: row.location?.name ?? null,
    requester_count: row.requesters?.[0]?.count ?? 0,
    measurement_revision: row.sku?.measurement_revision ?? 0,
  }));
}

export async function getMeasurementAssetProduction(
  skuId: string,
  revision: number,
): Promise<MeasurementAssetRow | null> {
  const { data, error } = await supabaseAdmin
    .from("product_measurement_assets" as never)
    .select("*")
    .eq("sku_id", skuId)
    .eq("revision", revision)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as MeasurementAssetRow | null) ?? null;
}

/**
 * 尺寸素材上报：ready 必须 verified + 完整几何 + 实测宽高 + 受控路径
 * （sku-listing 桶 measurements/{sku_id}/ 前缀，拒绝任意外链/他品路径）。
 */
export async function upsertMeasurementAssetProduction(
  row: MeasurementAssetRow & { verified?: boolean; width_cm?: number | null; height_cm?: number | null },
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("product_measurement_assets" as never)
    .upsert({ ...row, updated_at: new Date().toISOString() } as never, {
      onConflict: "sku_id,revision",
    });
  if (error) throw new Error(error.message);
}
