// 门店日目标 / 日销售汇总 / 线下补录 的服务端实现。
// 契约要点：
// - 金额一律整数分；日期一律 Asia/Shanghai 自然日。
// - 有赞侧只能给出「已付款毛额 - 运费」，退款数据源缺失时必须 incomplete，禁止称净销售。
// - 同步中断时也必须如实标注，禁止静默返回 0。
// - 目标写操作全部落审计；过期日与锁定日不被重算覆盖。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  allocateMonthlyTarget,
  type ExistingDay,
  type WeekdayWeights,
} from "@/lib/store-targets/allocation";
import {
  aggregateYouzanDay,
  computeDailyProgress,
  evaluateCompleteness,
  shanghaiDayWindow,
  shanghaiMonthOf,
  shanghaiToday,
  type Completeness,
  type YouzanOrderRow,
} from "@/lib/store-targets/sales-window";

export type ActorContext = {
  actorId: string | null;
  actorRole: string | null;
};

const db = () =>
  supabaseAdmin as unknown as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from: (t: string) => any;
  };

// ---------------------------------------------------------------- 日销售汇总

export type DailySummary = {
  location_id: string;
  date: string;
  month: string;
  target_fen: number | null;
  target_source: "allocated" | "manual_override" | "closed_day" | null;
  achieved_fen: number;
  gap_fen: number | null;
  progress_pct: number | null;
  youzan: {
    performance_fen: number;
    gross_paid_fen: number;
    shipping_fee_fen: number;
    order_count: number;
    excluded_order_count: number;
    shop_bound: boolean;
  };
  offline: {
    amount_fen: number;
    entry_count: number;
    order_count: number;
  };
  completeness: Completeness;
};

export async function loadDailySummary(params: {
  locationId: string;
  date?: string;
  now?: Date;
}): Promise<DailySummary> {
  const now = params.now ?? new Date();
  const date = params.date ?? shanghaiToday(now);
  const { startUtc, endUtc } = shanghaiDayWindow(date);

  const { data: loc } = await db()
    .from("inv_locations")
    .select("id, name, shop_id")
    .eq("id", params.locationId)
    .maybeSingle();
  const shopId: string | null = loc?.shop_id ?? null;

  // 有赞侧
  let youzanRows: YouzanOrderRow[] = [];
  let lastSyncedAt: string | null = null;
  if (shopId) {
    const { data: rows } = await db()
      .from("youzan_orders")
      .select("status, pay_time, payment, total_fee, post_fee")
      .eq("shop_id", shopId)
      .gte("pay_time", startUtc)
      .lt("pay_time", endUtc);
    youzanRows = (rows ?? []) as YouzanOrderRow[];

    const { data: syncRows } = await db()
      .from("youzan_sync_logs")
      .select("finished_at")
      .eq("shop_id", shopId)
      .eq("action", "orders")
      .eq("status", "ok")
      .order("finished_at", { ascending: false })
      .limit(1);
    lastSyncedAt = syncRows?.[0]?.finished_at ?? null;
  }
  const youzan = aggregateYouzanDay(youzanRows);

  // 线下补录
  const { data: offlineRows } = await db()
    .from("store_offline_sales_entries")
    .select("amount_fen, order_count")
    .eq("location_id", params.locationId)
    .eq("business_date", date)
    .eq("status", "active");
  const offline = ((offlineRows ?? []) as { amount_fen: number; order_count: number }[]).reduce<{
    amount_fen: number;
    entry_count: number;
    order_count: number;
  }>(
    (acc, r) => ({
      amount_fen: acc.amount_fen + Number(r.amount_fen || 0),
      entry_count: acc.entry_count + 1,
      order_count: acc.order_count + Number(r.order_count || 0),
    }),
    { amount_fen: 0, entry_count: 0, order_count: 0 },
  );

  // 日目标
  const { data: targetRow } = await db()
    .from("store_daily_targets")
    .select("target_amount_fen, source")
    .eq("location_id", params.locationId)
    .eq("target_date", date)
    .maybeSingle();

  const completeness = evaluateCompleteness({
    youzanLastSyncedAt: shopId ? lastSyncedAt : null,
    windowEndUtc: endUtc,
    hasRefundSource: false, // 当前本地没有有赞退款数据源
    now,
  });
  if (!shopId) completeness.reasons.push("location_not_bound_to_youzan_shop");
  if (!shopId) completeness.complete = false;

  const progress = computeDailyProgress({
    targetFen: targetRow ? Number(targetRow.target_amount_fen) : null,
    youzanPerformanceFen: youzan.performance_fen,
    offlineFen: offline.amount_fen,
  });

  return {
    location_id: params.locationId,
    date,
    month: shanghaiMonthOf(date),
    target_fen: progress.target_fen,
    target_source: targetRow?.source ?? null,
    achieved_fen: progress.achieved_fen,
    gap_fen: progress.gap_fen,
    progress_pct: progress.progress_pct,
    youzan: { ...youzan, shop_bound: !!shopId },
    offline,
    completeness,
  };
}

// ---------------------------------------------------------------- 目标发布

export type PublishPlanInput = {
  locationId: string;
  month: string; // yyyy-mm
  monthlyTargetFen: number;
  weekdayWeights?: WeekdayWeights;
  dateWeightOverrides?: Record<string, number>;
  closedDates?: string[];
  note?: string | null;
  reason?: string | null;
  today?: string;
};

export async function publishMonthlyPlan(input: PublishPlanInput, actor: ActorContext) {
  const today = input.today ?? shanghaiToday();
  const periodMonth = `${input.month}-01`;

  const { data: existingDayRows } = await db()
    .from("store_daily_targets")
    .select("target_date, target_amount_fen, source, is_locked")
    .eq("location_id", input.locationId)
    .gte("target_date", periodMonth)
    .lte("target_date", `${input.month}-31`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existingDays: ExistingDay[] = ((existingDayRows ?? []) as any[]).map((r) => ({
    date: r.target_date,
    target_amount_fen: Number(r.target_amount_fen),
    source: r.source,
    is_locked: !!r.is_locked,
  }));

  const allocation = allocateMonthlyTarget({
    month: input.month,
    monthlyTargetFen: input.monthlyTargetFen,
    weekdayWeights: input.weekdayWeights,
    dateWeightOverrides: input.dateWeightOverrides,
    closedDates: input.closedDates,
    existingDays,
    today,
  });

  // 版本号：同门店同月递增
  const { data: prevPlans } = await db()
    .from("store_monthly_target_plans")
    .select(
      "id, version, status, target_amount_fen, weekday_weights, date_weight_overrides, closed_dates",
    )
    .eq("location_id", input.locationId)
    .eq("period_month", periodMonth)
    .order("version", { ascending: false });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prevPublished = ((prevPlans ?? []) as any[]).find((p) => p.status === "published") ?? null;
  const latestVersion = Number(
    (((prevPlans ?? []) as { version?: number }[])[0]?.version ?? 0) || 0,
  );
  const nextVersion = latestVersion + 1;

  if (prevPublished) {
    await db()
      .from("store_monthly_target_plans")
      .update({ status: "archived", updated_by: actor.actorId })
      .eq("id", prevPublished.id);
  }

  const { data: plan, error } = await db()
    .from("store_monthly_target_plans")
    .insert({
      location_id: input.locationId,
      period_month: periodMonth,
      target_amount_fen: input.monthlyTargetFen,
      weekday_weights: input.weekdayWeights ?? undefined,
      date_weight_overrides: input.dateWeightOverrides ?? {},
      closed_dates: input.closedDates ?? [],
      version: nextVersion,
      status: "published",
      published_at: new Date().toISOString(),
      note: input.note ?? null,
      created_by: actor.actorId,
      updated_by: actor.actorId,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  // 只写入未冻结的日期
  const writable = allocation.days.filter((d) => !d.frozen);
  if (writable.length > 0) {
    const rows = writable.map((d) => ({
      location_id: input.locationId,
      target_date: d.date,
      target_amount_fen: d.target_amount_fen,
      plan_id: plan.id,
      plan_version: nextVersion,
      weight: d.weight,
      source: d.source,
      is_locked: false,
      created_by: actor.actorId,
      updated_by: actor.actorId,
    }));
    const { error: upErr } = await db()
      .from("store_daily_targets")
      .upsert(rows, { onConflict: "location_id,target_date" });
    if (upErr) throw new Error(upErr.message);
  }

  await db()
    .from("store_target_audit_logs")
    .insert({
      entity_type: "monthly_plan",
      entity_id: plan.id,
      location_id: input.locationId,
      period_month: periodMonth,
      action: "publish",
      before_snapshot: prevPublished ?? null,
      after_snapshot: {
        plan,
        allocation_summary: {
          frozen_fen: allocation.frozen_fen,
          distributable_fen: allocation.distributable_fen,
          total_fen: allocation.total_fen,
          warnings: allocation.warnings,
          written_days: writable.length,
        },
      },
      reason: input.reason ?? null,
      actor_id: actor.actorId,
      actor_role: actor.actorRole,
    });

  return { plan, allocation, written_days: writable.length };
}

export async function overrideDailyTarget(
  input: {
    locationId: string;
    date: string;
    targetAmountFen: number;
    lock?: boolean;
    note?: string | null;
    reason?: string | null;
  },
  actor: ActorContext,
) {
  if (!Number.isInteger(input.targetAmountFen) || input.targetAmountFen < 0) {
    throw new Error("日目标必须是非负整数分");
  }
  const { data: before } = await db()
    .from("store_daily_targets")
    .select("*")
    .eq("location_id", input.locationId)
    .eq("target_date", input.date)
    .maybeSingle();

  const { data: after, error } = await db()
    .from("store_daily_targets")
    .upsert(
      {
        location_id: input.locationId,
        target_date: input.date,
        target_amount_fen: input.targetAmountFen,
        source: "manual_override",
        is_locked: input.lock ?? true,
        note: input.note ?? null,
        plan_id: before?.plan_id ?? null,
        plan_version: before?.plan_version ?? null,
        updated_by: actor.actorId,
        created_by: before?.created_by ?? actor.actorId,
      },
      { onConflict: "location_id,target_date" },
    )
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await db()
    .from("store_target_audit_logs")
    .insert({
      entity_type: "daily_target",
      entity_id: after.id,
      location_id: input.locationId,
      target_date: input.date,
      action: "daily_override",
      before_snapshot: before ?? null,
      after_snapshot: after,
      reason: input.reason ?? null,
      actor_id: actor.actorId,
      actor_role: actor.actorRole,
    });
  return after;
}

// ---------------------------------------------------------------- 线下补录

export type OfflineEntryInput = {
  locationId: string;
  businessDate: string;
  channel: "cash" | "pos_card" | "wechat_qr" | "alipay_qr" | "bank_transfer" | "other";
  amountFen: number;
  orderCount?: number;
  evidenceType:
    | "pos_receipt"
    | "payment_screenshot"
    | "bank_slip"
    | "handwritten_slip"
    | "manual_declaration";
  evidenceRef?: string | null;
  evidenceUrl?: string | null;
  youzanExclusionBasis:
    | "device_not_youzan"
    | "operator_declared"
    | "reconciled_against_youzan"
    | "unverified";
  youzanExcludedTids?: string[];
  note?: string | null;
  clientOpId: string;
};

export async function createOfflineEntry(input: OfflineEntryInput, actor: ActorContext) {
  if (!Number.isInteger(input.amountFen) || input.amountFen === 0) {
    throw new Error("补录金额必须是非零整数分");
  }
  if (!input.clientOpId) throw new Error("缺少幂等操作 ID");
  if (input.evidenceType !== "manual_declaration" && !input.evidenceRef && !input.evidenceUrl) {
    throw new Error("除口头申报外，必须提供来源凭证编号或凭证图片");
  }

  // 幂等：同门店同 client_op_id 直接回放既有记录
  const { data: existing } = await db()
    .from("store_offline_sales_entries")
    .select("*")
    .eq("location_id", input.locationId)
    .eq("client_op_id", input.clientOpId)
    .maybeSingle();
  if (existing) {
    await db().from("store_offline_sales_audit_logs").insert({
      entry_id: existing.id,
      location_id: input.locationId,
      business_date: existing.business_date,
      action: "replay_idempotent",
      before_snapshot: existing,
      after_snapshot: existing,
      actor_id: actor.actorId,
      actor_role: actor.actorRole,
      client_op_id: input.clientOpId,
    });
    return { entry: existing, replayed: true };
  }

  const { data: entry, error } = await db()
    .from("store_offline_sales_entries")
    .insert({
      location_id: input.locationId,
      business_date: input.businessDate,
      channel: input.channel,
      amount_fen: input.amountFen,
      order_count: input.orderCount ?? 1,
      evidence_type: input.evidenceType,
      evidence_ref: input.evidenceRef ?? null,
      evidence_url: input.evidenceUrl ?? null,
      youzan_exclusion_basis: input.youzanExclusionBasis,
      youzan_excluded_tids: input.youzanExcludedTids ?? [],
      note: input.note ?? null,
      client_op_id: input.clientOpId,
      created_by: actor.actorId,
      updated_by: actor.actorId,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await db().from("store_offline_sales_audit_logs").insert({
    entry_id: entry.id,
    location_id: input.locationId,
    business_date: input.businessDate,
    action: "create",
    before_snapshot: null,
    after_snapshot: entry,
    actor_id: actor.actorId,
    actor_role: actor.actorRole,
    client_op_id: input.clientOpId,
  });
  return { entry, replayed: false };
}

export async function voidOfflineEntry(
  input: { entryId: string; reason: string },
  actor: ActorContext,
) {
  if (!input.reason) throw new Error("作废必须填写原因");
  const { data: before } = await db()
    .from("store_offline_sales_entries")
    .select("*")
    .eq("id", input.entryId)
    .maybeSingle();
  if (!before) throw new Error("补录记录不存在");

  const { data: after, error } = await db()
    .from("store_offline_sales_entries")
    .update({
      status: "voided",
      voided_by: actor.actorId,
      voided_at: new Date().toISOString(),
      void_reason: input.reason,
      updated_by: actor.actorId,
    })
    .eq("id", input.entryId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await db().from("store_offline_sales_audit_logs").insert({
    entry_id: input.entryId,
    location_id: before.location_id,
    business_date: before.business_date,
    action: "void",
    before_snapshot: before,
    after_snapshot: after,
    reason: input.reason,
    actor_id: actor.actorId,
    actor_role: actor.actorRole,
    client_op_id: before.client_op_id,
  });
  return after;
}

export async function listOfflineEntries(params: {
  locationId: string;
  dateFrom: string;
  dateTo: string;
  includeVoided?: boolean;
  limit?: number;
  offset?: number;
}) {
  let q = db()
    .from("store_offline_sales_entries")
    .select("*", { count: "exact" })
    .eq("location_id", params.locationId)
    .gte("business_date", params.dateFrom)
    .lte("business_date", params.dateTo)
    .order("business_date", { ascending: false })
    .order("id", { ascending: false })
    .range(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? 50) - 1);
  if (!params.includeVoided) q = q.eq("status", "active");
  const { data, count, error } = await q;
  if (error) throw new Error(error.message);
  return { items: data ?? [], total: count ?? 0 };
}
