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
  "id, measurement_height_cm, measurement_width_cm, measurement_depth_cm, measurement_diameter_cm, measured_by, measured_at, measurement_revision";

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

export type SkuStockRow = { location_id: string; qty: number };

/** SKU 在各门店的真实库存（inv_stocks；零库存行仍证明历史归属，可读不可改） */
export async function loadSkuStockRows(skuId: string): Promise<SkuStockRow[]> {
  const { data, error } = await supabaseAdmin
    .from("inv_stocks")
    .select("location_id, qty")
    .eq("sku_id", skuId);
  if (error) throw new Error("stock_read_failed");
  return ((data as SkuStockRow[] | null) ?? []).map((r) => ({ location_id: r.location_id, qty: Number(r.qty) }));
}

/** 顾客申请测量（事务 RPC：合并任务 + 申请者 + 门店手持提醒原子完成） */
export async function requestMeasurementProduction(
  listingId: string,
  customerId: string,
): Promise<{
  status: "pending" | "completed" | "unavailable";
  task_id: string | null;
  requested_at: string | null;
  message?: string;
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
  /** 任务所在门店当前确有正库存；false 表示挂起（仅总部可见诊断） */
  stock_available: boolean;
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
  const rows = (data as unknown as Array<{ sku_id: string; location_id: string | null }>) ?? [];
  // 以真实正库存过滤：任务所在门店当前确有实物才算可处理（门店员工只看到可处理的；总部看到全部 + 诊断标记）
  const positive = new Set<string>();
  const skuIds = [...new Set(rows.map((r) => r.sku_id))];
  if (skuIds.length) {
    const { data: stocks, error: stockError } = await supabaseAdmin
      .from("inv_stocks")
      .select("sku_id, location_id, qty")
      .in("sku_id", skuIds)
      .gt("qty", 0);
    if (stockError) throw new Error("stock_read_failed");
    for (const st of (stocks as Array<{ sku_id: string; location_id: string }> | null) ?? []) {
      positive.add(`${st.sku_id}:${st.location_id}`);
    }
  }
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
    stock_available: row.location_id != null && positive.has(`${row.sku_id}:${row.location_id}`),
  })).filter((row) => args.locationIds == null || row.stock_available);
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
 * 素材失败上报（failed-only）：绝不写 ready，也绝不把已 ready 的素材降级/覆盖。
 * ready 只能由 measurement_asset_register RPC（新上传端点）在 sku 行锁内登记。
 */
export async function markMeasurementAssetFailedProduction(args: {
  skuId: string;
  revision: number;
  error: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await supabaseAdmin
    .from("product_measurement_assets" as never)
    .update({ status: "failed", error: args.error, verified: false, updated_at: now } as never)
    .eq("sku_id", args.skuId)
    .eq("revision", args.revision)
    .neq("status", "ready")
    .select("sku_id");
  if (updateError) throw new Error("asset_write_failed");
  if ((updated as unknown[] | null)?.length) return;
  const { error: insertError } = await supabaseAdmin
    .from("product_measurement_assets" as never)
    .upsert(
      { sku_id: args.skuId, revision: args.revision, status: "failed", error: args.error, verified: false, updated_at: now } as never,
      { onConflict: "sku_id,revision", ignoreDuplicates: true },
    );
  if (insertError) throw new Error("asset_write_failed");
}

export type MeasurementAssetRegisterResult = {
  status: "ready";
  revision: number;
  location_id: string;
  cutout_preview_path: string;
  width_cm: number;
  height_cm: number;
  replayed: boolean;
};

export const MEASUREMENT_REGISTER_ERRORS = [
  "revision_conflict",
  "op_conflict",
  "image_conflict",
  "location_mismatch",
  "unauthorized_role",
  "not_found",
  "invalid_asset",
  "client_op_id_required",
] as const;

/**
 * 素材登记：service-role RPC，sku FOR UPDATE 内复核当前 location/revision/实测宽高/actor 权限，
 * 资产与 op 指纹同事务落库；返回登记结果（HTTP 成功必须基于它）。
 * 失败只抛受控 code，不外泄 DB 原始错误。
 */
export async function registerMeasurementAssetProduction(args: {
  skuId: string;
  actorId: string;
  clientOpId: string;
  locationId: string;
  revision: number;
  heightCm: number;
  widthCm: number;
  contentHash: string;
  previewPath: string;
  bbox: { x: number; y: number; w: number; h: number };
  frontWidthPx: number;
  frontHeightPx: number;
  pxPerCm: number;
}): Promise<MeasurementAssetRegisterResult> {
  const { data, error } = await supabaseAdmin.rpc("measurement_asset_register" as never, {
    p_sku_id: args.skuId,
    p_actor_id: args.actorId,
    p_client_op_id: args.clientOpId,
    p_location_id: args.locationId,
    p_revision: args.revision,
    p_height_cm: args.heightCm,
    p_width_cm: args.widthCm,
    p_content_hash: args.contentHash,
    p_preview_path: args.previewPath,
    p_bbox: args.bbox,
    p_front_width_px: args.frontWidthPx,
    p_front_height_px: args.frontHeightPx,
    p_px_per_cm: args.pxPerCm,
  } as never);
  if (error) {
    const msg = String((error as { message?: string }).message ?? "");
    const code = MEASUREMENT_REGISTER_ERRORS.find((c) => msg.includes(c));
    if (!code) console.error("[measurement_asset_register]", msg);
    throw new Error(code ?? "register_failed");
  }
  const result = data as unknown as MeasurementAssetRegisterResult | null;
  if (
    !result ||
    result.status !== "ready" ||
    result.revision !== args.revision ||
    result.location_id !== args.locationId ||
    result.cutout_preview_path !== args.previewPath
  ) {
    throw new Error("register_failed");
  }
  return result;
}

/** 上传受控衍生 PNG 到 sku-listing/measurements/ 前缀；失败只返回受控 code，不外泄存储原始错误 */
export async function uploadMeasurementDerivativeProduction(path: string, png: Buffer): Promise<void> {
  if (!/^measurements\/[0-9a-f-]{36}\/\d+-[0-9a-f]{16}-(640|1280)\.png$/.test(path)) {
    throw new Error("invalid_asset");
  }
  const { error } = await supabaseAdmin.storage
    .from("sku-listing")
    .upload(path, png, { contentType: "image/png", upsert: true });
  if (error) {
    console.error("[measurement upload]", error.message);
    throw new Error("storage_failed");
  }
}
