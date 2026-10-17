/**
 * ERP 尺寸待办服务端函数：列表 / 领取 / 录入实测 / 素材状态上报。
 * 全部 requireSupabaseAuth；门店权限 = user_location_perms，总部角色全通。
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
  completeTaskProduction,
  findActiveTaskProduction,
  getMeasurementAssetProduction,
  listMeasurementTasksProduction,
  loadMeasurementSku,
  notifyRequestersProduction,
  saveSkuMeasurementProduction,
  upsertMeasurementAssetProduction,
} from "@/server/product-measurement-production.server";
import { loadUserRoles, userCanAccessLocation } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

async function loadActor(userId: string): Promise<MeasurementActor> {
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

/** 尺寸待办列表：员工只见授权门店，总部可见全部 */
export const listMeasurementTasks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        status: z.enum(["pending", "claimed", "completed"]).optional(),
      })
      .strict()
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const actor = await loadActor(context.userId);
    const isHq = actor.roles.includes("super_admin") || actor.roles.includes("hq_operator");
    if (!isHq && actor.locationIds.length === 0) return { items: [] };
    const items = await listMeasurementTasksProduction({
      locationIds: isHq ? null : actor.locationIds,
      status: data.status,
    });
    return { items };
  });

/** 领取任务（同任务被他人领取则冲突） */
export const claimMeasurementTaskFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ task_id: z.string().uuid() }).strict().parse(input),
  )
  .handler(async ({ data, context }) => {
    const actor = await loadActor(context.userId);
    const { data: task } = await supabaseAdmin
      .from("product_measurement_tasks" as never)
      .select("*")
      .eq("id", data.task_id)
      .maybeSingle();
    const row = task as unknown as {
      id: string;
      status: string;
      location_id: string | null;
      claimed_by: string | null;
    } | null;
    if (!row || row.status === "completed" || row.status === "cancelled") {
      throw new Error("任务不存在或已结束");
    }
    if (!actorCanAccessLocation(actor, row.location_id)) throw new Error("无该门店权限");
    if (row.status === "claimed" && row.claimed_by && row.claimed_by !== actor.userId) {
      throw new Error("任务已被其他同事领取");
    }
    const { error } = await supabaseAdmin
      .from("product_measurement_tasks" as never)
      .update({
        status: "claimed",
        claimed_by: actor.userId,
        claimed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id", row.id)
      .eq("status", row.status);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * 保存实测尺寸：可挂在任务上（完成并通知申请者），也可直接在商品上保存。
 * 版本 CAS：expected_revision 与当前不一致时拒绝，防止并发覆盖。
 */
export const saveMeasurement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        task_id: z.string().uuid().optional(),
        sku_id: z.string().uuid().optional(),
        expected_revision: z.number().int().min(0).optional(),
        measurement: measurementInput,
      })
      .strict()
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const actor = await loadActor(context.userId);
    const parsed = validateMeasurementInput(data.measurement);
    if (!parsed.ok) throw new Error("尺寸需为正的有限数值（cm）");
    if (!hasAnyMeasurement(parsed.value)) throw new Error("至少填写一项尺寸");

    let skuId = data.sku_id ?? null;
    let taskId = data.task_id ?? null;
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

    const revision = await saveSkuMeasurementProduction(
      skuId,
      parsed.value,
      actor.userId,
      data.expected_revision,
    );

    let notified = 0;
    if (taskId) {
      await completeTaskProduction(taskId, actor.userId);
      notified = await notifyRequestersProduction(taskId);
    } else {
      // 直接保存时，若存在活跃任务也一并完成并通知
      const active = await findActiveTaskProduction(skuId);
      if (active) {
        await completeTaskProduction(active.id, actor.userId);
        notified = await notifyRequestersProduction(active.id);
        taskId = active.id;
      }
    }
    return { ok: true, revision, task_id: taskId, notified };
  });

/**
 * 尺寸素材上报（透明分割 worker 调用；需总部角色或 service 场景）。
 * 版本不符一律 stale_revision 拒绝；ready 必须具备抠图路径 + 完整几何。
 */
export const reportMeasurementDiagram = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        sku_id: z.string().uuid(),
        revision: z.number().int().min(0),
        status: z.enum(["ready", "failed"]),
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
    const actor = await loadActor(context.userId);
    const sku = await loadMeasurementSku(data.sku_id);
    if (!sku) throw new Error("商品不存在");
    if (!actorCanAccessLocation(actor, sku.location_id)) throw new Error("无该门店权限");
    if (data.revision !== sku.measurement_revision) throw new Error("stale_revision");

    if (data.status === "ready") {
      const ok =
        data.cutout_preview_path &&
        data.bbox &&
        data.front_width_px &&
        data.front_height_px &&
        data.px_per_cm;
      if (!ok) throw new Error("incomplete_asset");
    }

    await upsertMeasurementAssetProduction({
      sku_id: data.sku_id,
      revision: data.revision,
      status: data.status,
      cutout_preview_path: data.status === "ready" ? (data.cutout_preview_path ?? null) : null,
      bbox: data.status === "ready" ? (data.bbox ?? null) : null,
      front_width_px: data.status === "ready" ? (data.front_width_px ?? null) : null,
      front_height_px: data.status === "ready" ? (data.front_height_px ?? null) : null,
      px_per_cm: data.status === "ready" ? (data.px_per_cm ?? null) : null,
      error: data.status === "failed" ? (data.error ?? "unknown") : null,
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
    const sku = await loadMeasurementSku(data.sku_id);
    if (!sku) throw new Error("商品不存在");
    if (!(await userCanAccessLocation(context.userId, sku.location_id ?? ""))) {
      throw new Error("无该门店权限");
    }
    const asset = await getMeasurementAssetProduction(data.sku_id, sku.measurement_revision);
    return { sku, asset };
  });
