/**
 * product-measurement 的 Supabase 生产存储实现。
 * 全部走 service_role（表无 anon/authenticated 授权与策略），
 * 调用方必须先完成消费者/员工身份与门店权限校验。
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type {
  MeasurementAssetRow,
  MeasurementListingRow,
  MeasurementSkuRow,
  MeasurementStore,
  MeasurementTaskRow,
  MeasurementValues,
} from "./product-measurement.server";

async function loadSku(id: string): Promise<MeasurementSkuRow | null> {
  const { data } = await supabaseAdmin
    .from("inv_skus")
    .select("id, location_id, measurement_revision, measured_at, measured_by")
    .eq("id", id)
    .maybeSingle();
  return (data as MeasurementSkuRow | null) ?? null;
}

async function loadListing(id: string): Promise<MeasurementListingRow | null> {
  const { data } = await supabaseAdmin
    .from("commerce_listings" as never)
    .select("id, sku_id, location_id, status, published_at")
    .eq("id", id)
    .maybeSingle();
  return (data as unknown as MeasurementListingRow | null) ?? null;
}

export function createProductionMeasurementStore(): MeasurementStore {
  const store: MeasurementStore = {
    // 生产实现不使用内存 Map；仅为满足接口占位。
    skus: new Map(),
    listings: new Map(),
    tasks: new Map(),
    requesters: new Map(),
    assets: new Map(),
    notifications: [],

    findActiveTask: () => null, // 未被调用：requestMeasurement 走下方专用实现
    createTask: () => {
      throw new Error("unreachable");
    },
    addRequester: () => {},
    updateTask: () => {},
    notify: () => {},

    saveSkuMeasurement: () => {
      throw new Error("use saveSkuMeasurementProduction");
    },
    upsertAsset: () => {
      throw new Error("use upsertMeasurementAssetProduction");
    },
    getAsset: () => null,
  };
  return store;
}

export async function findActiveTaskProduction(skuId: string): Promise<MeasurementTaskRow | null> {
  const { data } = await supabaseAdmin
    .from("product_measurement_tasks" as never)
    .select("*")
    .eq("sku_id", skuId)
    .in("status", ["pending", "claimed"])
    .maybeSingle();
  return (data as unknown as MeasurementTaskRow | null) ?? null;
}

export async function createTaskProduction(
  row: Omit<MeasurementTaskRow, "id" | "created_at">,
): Promise<MeasurementTaskRow> {
  const { data, error } = await supabaseAdmin
    .from("product_measurement_tasks" as never)
    .insert(row as never)
    .select("*")
    .single();
  if (error) {
    // 并发下唯一索引冲突：回读已存在的活跃任务（合并语义）
    if (error.code === "23505") {
      const existing = await findActiveTaskProduction(row.sku_id);
      if (existing) return existing;
    }
    throw new Error(error.message);
  }
  return data as unknown as MeasurementTaskRow;
}

export async function addRequesterProduction(taskId: string, customerId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("product_measurement_requesters" as never)
    .upsert({ task_id: taskId, customer_id: customerId } as never, {
      onConflict: "task_id,customer_id",
      ignoreDuplicates: true,
    });
  if (error) throw new Error(error.message);
}

export async function loadMeasurementSku(id: string) {
  return loadSku(id);
}

export async function loadMeasurementListing(id: string) {
  return loadListing(id);
}

export async function saveSkuMeasurementProduction(
  skuId: string,
  v: MeasurementValues,
  measuredBy: string,
  expectedRevision?: number,
): Promise<number> {
  const sku = await loadSku(skuId);
  if (!sku) throw new Error("not_found");
  if (expectedRevision != null && sku.measurement_revision !== expectedRevision) {
    throw new Error("revision_conflict");
  }
  const revision = sku.measurement_revision + 1;
  let query = supabaseAdmin
    .from("inv_skus")
    .update({
      measurement_height_cm: v.height_cm,
      measurement_width_cm: v.width_cm,
      measurement_depth_cm: v.depth_cm,
      measurement_diameter_cm: v.diameter_cm,
      measured_by: measuredBy,
      measured_at: new Date().toISOString(),
      measurement_revision: revision,
    } as never)
    .eq("id", skuId)
    // 版本 CAS：并发保存时只有一个成功
    .eq("measurement_revision", sku.measurement_revision);
  const { data, error } = await query.select("id");
  if (error) throw new Error(error.message);
  if (!data || (data as unknown[]).length === 0) throw new Error("revision_conflict");
  return revision;
}

export async function completeTaskProduction(taskId: string, completedBy: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("product_measurement_tasks" as never)
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      completed_by: completedBy,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("id", taskId)
    .in("status", ["pending", "claimed"]);
  if (error) throw new Error(error.message);
}

export async function notifyRequestersProduction(taskId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("product_measurement_requesters" as never)
    .select("customer_id")
    .eq("task_id", taskId)
    .is("notified_at", null);
  if (error) throw new Error(error.message);
  const rows = (data as unknown as Array<{ customer_id: string }>) ?? [];
  if (rows.length === 0) return 0;
  const { error: insertError } = await supabaseAdmin
    .from("commerce_customer_notifications" as never)
    .insert(
      rows.map((row) => ({
        customer_id: row.customer_id,
        kind: "measurement_completed",
        title: "商品尺寸已测量",
        body: "您申请测量的商品尺寸已更新，打开商品详情即可查看。",
        dedupe_key: `measurement:${taskId}`,
      })) as never,
    );
  if (insertError) throw new Error(insertError.message);
  await supabaseAdmin
    .from("product_measurement_requesters" as never)
    .update({ notified_at: new Date().toISOString() } as never)
    .eq("task_id", taskId)
    .is("notified_at", null);
  return rows.length;
}

export async function upsertMeasurementAssetProduction(row: MeasurementAssetRow): Promise<void> {
  const { error } = await supabaseAdmin
    .from("product_measurement_assets" as never)
    .upsert(
      { ...row, updated_at: new Date().toISOString() } as never,
      { onConflict: "sku_id,revision" },
    );
  if (error) throw new Error(error.message);
}

export async function getMeasurementAssetProduction(
  skuId: string,
  revision: number,
): Promise<MeasurementAssetRow | null> {
  const { data } = await supabaseAdmin
    .from("product_measurement_assets" as never)
    .select("*")
    .eq("sku_id", skuId)
    .eq("revision", revision)
    .maybeSingle();
  return (data as unknown as MeasurementAssetRow | null) ?? null;
}

export async function listMeasurementTasksProduction(args: {
  locationIds: string[] | null; // null = 总部全量
  status?: "pending" | "claimed" | "completed";
}): Promise<Array<MeasurementTaskRow & { sku_name: string | null; location_name: string | null }>> {
  let query = supabaseAdmin
    .from("product_measurement_tasks" as never)
    .select("*, sku:inv_skus(name), location:inv_locations(name)")
    .order("created_at", { ascending: false })
    .limit(200);
  if (args.locationIds) query = query.in("location_id", args.locationIds);
  query = query.eq("status", args.status ?? "pending");
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data as unknown as Array<
    MeasurementTaskRow & { sku: { name: string } | null; location: { name: string } | null }
  >) ?? []).map((row) => ({
    ...row,
    sku_name: row.sku?.name ?? null,
    location_name: row.location?.name ?? null,
  }));
}
