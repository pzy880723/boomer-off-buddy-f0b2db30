/**
 * ERP 尺寸待办服务端函数：列表 / 领取 / 录入实测 / 素材状态上报。
 * 全部 requireSupabaseAuth；门店权限 = user_location_perms，总部角色全通。
 * 保存走事务 RPC（版本 CAS + client_op_id 幂等 + 通知原子）。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { reportMeasurementDiagramInput } from "@/lib/measurement-schemas";
import {
  actorCanAccessLocation,
  actorCanReadSkuMeasurement,
  resolveEditableLocation,
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
  loadSkuStockRows,
  replaySaveProduction,
  saveMeasurementProduction,
  markMeasurementAssetFailedProduction,
} from "@/server/product-measurement-production.server";
import { loadMeasurementActor } from "@/server/measurement-actor.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";


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

/** 领取任务：measurement_claim 事务 RPC 为唯一权限与状态出口 */
export const claimMeasurementTaskFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ task_id: z.string().uuid() }).strict().parse(input),
  )
  .handler(async ({ data, context }) => {
    // 权限/门店/库存全部在 measurement_claim RPC 锁内校验，不做预读鉴权
    try {
      await claimTaskProduction(data.task_id, context.userId);
    } catch (error) {
      const message = (error as Error).message;
      if (message === "already_claimed") throw new Error("任务已被其他同事领取");
      if (message === "not_found") throw new Error("任务不存在或已结束");
      if (message === "forbidden") throw new Error("无该门店权限");
      if (message === "no_stock") throw new Error("该店暂无实物，任务已挂起");
      throw new Error("服务暂时不可用，请稍后再试");
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
        location_id: z.string().uuid().optional(),
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
    let taskLocation: string | null = null;

    if (taskId) {
      const { data: task } = await supabaseAdmin
        .from("product_measurement_tasks" as never)
        .select("id, sku_id, location_id, status")
        .eq("id", taskId)
        .maybeSingle();
      const row = task as unknown as { id: string; sku_id: string; location_id: string | null } | null;
      // 已结束任务不在这里拒绝：同 op 重试需到达 RPC 做幂等回放
      if (row) {
        skuId = skuId ?? row.sku_id;
        taskLocation = row.location_id;
      }
    }
    if (!skuId) throw new Error("缺少商品");
    const sku = await loadMeasurementSku(skuId);
    if (!sku) throw new Error("商品不存在");

    // 已成功 op 回放：只匹配当前 actor + 原 op + 完全一致指纹，命中直接返回原结果、不写库；
    // 未命中继续全部当前权限/正库存/版本校验
    let replay;
    try {
      replay = await replaySaveProduction({
        skuId,
        actorId: actor.userId,
        clientOpId: data.client_op_id,
        expectedRevision: data.expected_revision,
        value: parsed.value,
      });
    } catch (error) {
      if ((error as Error).message === "op_conflict") throw new Error("同一操作编号提交了不同内容，请换新编号");
      throw new Error("服务暂时不可用，请稍后再试");
    }
    if (replay) return replay;

    // 门店 = inv_stocks 真实正库存（指定 > 任务所在店 > 员工唯一可编辑有货门店）；RPC 锁内再复核
    const stocks = await loadSkuStockRows(skuId);
    const resolved = resolveEditableLocation(actor, stocks, data.location_id ?? taskLocation);
    if (!resolved.ok) {
      if (resolved.error === "forbidden") throw new Error("无该门店权限");
      if (resolved.error === "ambiguous") throw new Error("该商品在多个门店有货，请从对应门店的测量待办录入");
      throw new Error("该门店暂无此商品实物，不能录入尺寸");
    }
    const locationId = resolved.locationId;

    try {
      return await saveMeasurementProduction({
        skuId,
        taskId,
        actorId: actor.userId,
        clientOpId: data.client_op_id,
        expectedRevision: data.expected_revision,
        locationId,
        value: parsed.value,
      });
    } catch (error) {
      const message = (error as Error).message;
      if (message === "revision_conflict") throw new Error("尺寸已被他人更新，请刷新后重试");
      if (message === "op_conflict") throw new Error("同一操作编号提交了不同内容，请换新编号");
      if (message === "location_mismatch") throw new Error("该门店已无此商品实物，请刷新后重试");
      if (message === "unauthorized_role") throw new Error("无该门店权限");
      if (message === "not_found") throw new Error("任务不存在或已结束");
      throw error;
    }
  });

/**
 * 尺寸素材失败上报（failed-only）。
 * ready 一律拒绝：唯一 ready 入口是 POST /api/public/handheld/items/{id}/measurement-image
 * （服务端 PNG 校验 + measurement_asset_register 行锁 CAS）。failed 也不会覆盖已 ready 素材。
 */
export const reportMeasurementDiagram = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => reportMeasurementDiagramInput.parse(input))
  .handler(async ({ data, context }) => {
    // 双重拒绝：即便绕过 schema，handler 也只接受 failed
    if ((data as { status: string }).status !== "failed") throw new Error("ready_not_allowed");
    const actor = await loadMeasurementActor(context.userId);
    const sku = await loadMeasurementSku(data.sku_id);
    if (!sku) throw new Error("商品不存在");
    if (!actorCanReadSkuMeasurement(actor, await loadSkuStockRows(sku.id))) throw new Error("无该门店权限");
    if (data.revision !== sku.measurement_revision) throw new Error("stale_revision");
    await markMeasurementAssetFailedProduction({
      skuId: data.sku_id,
      revision: data.revision,
      error: data.error ?? "unknown",
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
    if (!actorCanReadSkuMeasurement(actor, await loadSkuStockRows(sku.id))) throw new Error("无该门店权限");
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
    if (!actorCanReadSkuMeasurement(actor, await loadSkuStockRows(sku.id))) throw new Error("无该门店权限");
    const active = await findActiveTaskProduction(data.sku_id);
    return { revision: sku.measurement_revision, active_task_id: active?.id ?? null };
  });
