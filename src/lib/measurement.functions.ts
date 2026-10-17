/**
 * ERP 尺寸待办服务端函数：列表 / 领取 / 录入实测 / 素材状态上报。
 * 全部 requireSupabaseAuth；门店权限 = user_location_perms，总部角色全通。
 * 保存走事务 RPC（版本 CAS + client_op_id 幂等 + 通知原子）。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  actorCanAccessLocation,
  validateMeasurementInput,
  hasAnyMeasurement,
  type MeasurementActor,
} from "@/server/product-measurement.server";
import {
  claimTaskProduction,
  findActiveTaskProduction,
  getMeasurementAssetProduction,
  listMeasurementTasksProduction,
  loadMeasurementSku,
  saveMeasurementProduction,
  upsertMeasurementAssetProduction,
} from "@/server/product-measurement-production.server";
import { loadUserRoles } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export async function loadMeasurementActor(userId: string): Promise<MeasurementActor> {
  const roles = await loadUserRoles(userId);
  const isHq = roles.includes("super_admin") || roles.includes("hq_operator");
  let locationIds: string[] = [];
  if (!isHq) {
    const { data } = await supabaseAdmin
      .from("user_location_perms" as never)
      .select("location_id")
      .eq("user_id", userId);
    locationIds = ((data as { location_id: string }[] | null) ?? []).map((p) => p.location_id);
  }
  return { userId, roles, locationIds };
}

const measurementInput = z
  .object({
    height_cm: z.number().positive().max(9999.99).nullable().optional(),
    width_cm: z.number().positive().max(9999.99).nullable().optional(),
    depth_cm: z.number().positive().max(9999.99).nullable().optional(),
    diameter_cm: z.number().positive().max(9999.99).nullable().optional(),
  })
  .strict();

/** 尺寸待办列表：员工只见授权门店，总部可见全部；默认 pending+claimed */
export const listMeasurementTasks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        statuses: z.array(z.enum(["pending", "claimed", "completed"])).max(3).optional(),
      })
      .strict()
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const actor = await loadMeasurementActor(context.userId);
    const isHq = actor.roles.includes("super_admin") || actor.roles.includes("hq_operator");
    if (!isHq && actor.locationIds.length === 0) return { items: [] };
    const items = await listMeasurementTasksProduction({
      locationIds: isHq ? null : actor.locationIds,
      statuses: data.statuses,
    });
    return { items };
  });

/** 领取任务（受影响行核对，竞态失败报 already_claimed，不报假成功） */
export const claimMeasurementTaskFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ task_id: z.string().uuid() }).strict().parse(input),
  )
  .handler(async ({ data, context }) => {
    const actor = await loadMeasurementActor(context.userId);
    const { data: task } = await supabaseAdmin
      .from("product_measurement_tasks" as never)
      .select("id, location_id, status")
      .eq("id", data.task_id)
      .maybeSingle();
    const row = task as unknown as { id: string; location_id: string | null; status: string } | null;
    if (!row) throw new Error("任务不存在或已结束");
    if (!actorCanAccessLocation(actor, row.location_id)) throw new Error("无该门店权限");
    try {
      await claimTaskProduction(data.task_id, actor.userId);
    } catch (error) {
      const message = (error as Error).message;
      if (message === "already_claimed") throw new Error("任务已被其他同事领取");
      if (message === "not_found") throw new Error("任务不存在或已结束");
      throw error;
    }
    return { ok: true };
  });

/**
 * 保存实测尺寸：expected_revision 必填（版本 CAS），client_op_id 幂等；
 * 任务完成与顾客通知在同一事务。可挂任务或直接按商品保存（有活跃任务需传 task_id）。
 */
export const saveMeasurement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        task_id: z.string().uuid().optional(),
        sku_id: z.string().uuid().optional(),
        expected_revision: z.number().int().min(0),
        client_op_id: z.string().min(8).max(128),
        measurement: measurementInput,
      })
      .strict()
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const actor = await loadMeasurementActor(context.userId);
    const parsed = validateMeasurementInput(data.measurement);
    if (!parsed.ok) throw new Error("尺寸需为正的有限数值（cm）");
    if (!hasAnyMeasurement(parsed.value)) throw new Error("至少填写一项尺寸");

    let skuId = data.sku_id ?? null;
    const taskId = data.task_id ?? null;
    let locationId: string | null = null;

    if (taskId) {
      const { data: task } = await supabaseAdmin
        .from("product_measurement_tasks" as never)
        .select("id, sku_id, location_id, status")
        .eq("id", taskId)
        .maybeSingle();
      const row = task as unknown as {
        id: string;
        sku_id: string;
        location_id: string | null;
        status: string;
      } | null;
      if (!row || row.status === "completed" || row.status === "cancelled") {
        throw new Error("任务不存在或已结束");
      }
      skuId = row.sku_id;
      locationId = row.location_id;
    }
    if (!skuId) throw new Error("缺少商品");
    const sku = await loadMeasurementSku(skuId);
    if (!sku) throw new Error("商品不存在");
    locationId = locationId ?? sku.location_id;

    if (!actorCanAccessLocation(actor, locationId)) throw new Error("无该门店权限");

    try {
      return await saveMeasurementProduction({
        skuId,
        taskId,
        actorId: actor.userId,
        clientOpId: data.client_op_id,
        expectedRevision: data.expected_revision,
        value: parsed.value,
      });
    } catch (error) {
      const message = (error as Error).message;
      if (message === "revision_conflict") throw new Error("尺寸已被他人更新，请刷新后重试");
      if (message === "not_found") throw new Error("任务不存在或已结束");
      throw error;
    }
  });

/**
 * 尺寸素材上报（透明分割 worker 调用）。
 * ready 必须：revision 等于当前实测版本 + verified=true（人工确认正视图）+
 * 完整几何 + 实测宽高 + 受控路径（sku-listing 桶 measurements/{sku_id}/ 前缀 PNG）。
 * 拒绝任意外链和他品路径；旧版本一律 stale_revision。
 */
export const reportMeasurementDiagram = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        sku_id: z.string().uuid(),
        revision: z.number().int().min(0),
        status: z.enum(["ready", "failed"]),
        verified: z.boolean().optional(),
        width_cm: z.number().positive().max(9999.99).nullable().optional(),
        height_cm: z.number().positive().max(9999.99).nullable().optional(),
        cutout_preview_path: z.string().max(2048).nullable().optional(),
        bbox: z
          .object({
            x: z.number().min(0),
            y: z.number().min(0),
            w: z.number().positive(),
            h: z.number().positive(),
          })
          .nullable()
          .optional(),
        front_width_px: z.number().int().positive().nullable().optional(),
        front_height_px: z.number().int().positive().nullable().optional(),
        px_per_cm: z.number().positive().nullable().optional(),
        error: z.string().max(500).nullable().optional(),
      })
      .strict()
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const actor = await loadMeasurementActor(context.userId);
    const sku = await loadMeasurementSku(data.sku_id);
    if (!sku) throw new Error("商品不存在");
    if (!actorCanAccessLocation(actor, sku.location_id)) throw new Error("无该门店权限");
    if (data.revision !== sku.measurement_revision) throw new Error("stale_revision");

    const path = data.cutout_preview_path ?? null;
    const pathOk =
      path &&
      path.startsWith(`sku-listing/measurements/${data.sku_id}/`) &&
      path.endsWith(".png") &&
      !path.includes("..") &&
      !/[?#\s]/.test(path);

    if (data.status === "ready") {
      const ok =
        data.verified === true &&
        pathOk &&
        data.bbox &&
        data.front_width_px &&
        data.front_height_px &&
        data.px_per_cm &&
        data.width_cm &&
        data.height_cm;
      if (!ok) throw new Error("incomplete_asset");
    }

    await upsertMeasurementAssetProduction({
      sku_id: data.sku_id,
      revision: data.revision,
      status: data.status,
      cutout_preview_path: data.status === "ready" ? path : null,
      bbox: data.status === "ready" ? (data.bbox ?? null) : null,
      front_width_px: data.status === "ready" ? (data.front_width_px ?? null) : null,
      front_height_px: data.status === "ready" ? (data.front_height_px ?? null) : null,
      px_per_cm: data.status === "ready" ? (data.px_per_cm ?? null) : null,
      error: data.status === "failed" ? (data.error ?? "unknown") : null,
      verified: data.status === "ready",
      width_cm: data.status === "ready" ? (data.width_cm ?? null) : null,
      height_cm: data.status === "ready" ? (data.height_cm ?? null) : null,
    });
    return { ok: true };
  });

/** 商品当前尺寸 + 素材状态（ERP 编辑页回显用） */
export const getMeasurement = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ sku_id: z.string().uuid() }).strict().parse(input),
  )
  .handler(async ({ data, context }) => {
    const actor = await loadMeasurementActor(context.userId);
    const sku = await loadMeasurementSku(data.sku_id);
    if (!sku) throw new Error("商品不存在");
    if (!actorCanAccessLocation(actor, sku.location_id)) throw new Error("无该门店权限");
    const asset = await getMeasurementAssetProduction(data.sku_id, sku.measurement_revision);
    return { sku, asset };
  });

/** 保存前查询商品当前 revision（手持/ERP 保存前必读，构造 expected_revision） */
export const getMeasurementRevision = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ sku_id: z.string().uuid() }).strict().parse(input),
  )
  .handler(async ({ data, context }) => {
    const actor = await loadMeasurementActor(context.userId);
    const sku = await loadMeasurementSku(data.sku_id);
    if (!sku) throw new Error("商品不存在");
    if (!actorCanAccessLocation(actor, sku.location_id)) throw new Error("无该门店权限");
    const active = await findActiveTaskProduction(data.sku_id);
    return { revision: sku.measurement_revision, active_task_id: active?.id ?? null };
  });
