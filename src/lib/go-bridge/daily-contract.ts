/**
 * BOOMER GO 首页 daily-summary 的最终 JSON 契约（纯逻辑，可单测）。
 *
 * 铁律：
 *  - 源查询失败绝不能吞成 0：失败门店 actual_fen=null + status="error"。
 *  - 当天没有被成功同步窗口覆盖时，不允许拿 0 冒充实绩。
 *  - 缺退款数据源 → complete=false，口径只能是 paid_gross。
 *  - 任一门店金额为 null → 合计为 null，绝不按 0 相加。
 */
import { gapFen, sumNullable, type GoScopeMode } from "./scope";

export type GoStoreInput =
  | {
      status: "error";
      location_id: string;
      name: string;
      code: string;
      message?: string;
    }
  | {
      status: "ok";
      location_id: string;
      name: string;
      target_fen: number | null;
      youzan_fen: number | null;
      offline_fen: number | null;
      youzan_order_count: number | null;
      offline_order_count: number | null;
      youzan_bound: boolean;
      /** 最近一次成功的有赞订单同步覆盖到的时间点（ISO），没有则 null */
      youzan_synced_through: string | null;
      /** 该业务日是否被成功完成的同步窗口完整覆盖 */
      day_covered_by_sync: boolean;
      has_current_day_snapshot: boolean;
      source_fresh: boolean;
      has_refund_source: boolean;
      offline_entry_count: number | null;
    };

export type GoStoreOut = {
  location_id: string;
  name: string;
  status: "ok" | "error";
  target_fen: number | null;
  actual_fen: number | null;
  gap_fen: number | null;
  order_count: number | null;
  breakdown: {
    youzan_fen: number | null;
    offline_fen: number | null;
    offline_entry_count: number | null;
  };
  completeness: {
    complete: boolean;
    /** actual_fen 的口径：net=已扣退款净额；paid_gross=已付款毛额（无退款源时只能是它） */
    kind: "paid_gross" | "net";
    /** 退款数据源是否可用；false 时 kind 必为 paid_gross 且 complete=false */
    refunds_complete: boolean;
    reasons: string[];
    youzan_synced_through: string | null;
    day_covered_by_sync: boolean;
    source_fresh: boolean;
  };
  /** 同步时效水位：与 generated_at（响应生成时间）严格区分 */
  freshness: {
    /** 有赞订单同步真实覆盖到的时间点（ISO），未知为 null。绝不等于 generated_at */
    synced_through: string | null;
    day_covered_by_sync: boolean;
    fresh: boolean;
  };
};

export type GoDailySummary = {
  date: string;
  scope: { mode: GoScopeMode; location_ids: string[]; today_location_id: string | null };
  totals: {
    target_fen: number | null;
    actual_fen: number | null;
    gap_fen: number | null;
    order_count: number | null;
    store_count: number;
  };
  stores: GoStoreOut[];
  completeness: {
    complete: boolean;
    kind: "paid_gross" | "net";
    refunds_complete: boolean;
    reasons: string[];
  };
  /** 范围内所有门店取最保守值；synced_through 为最早水位，任一未知即 null */
  freshness: {
    synced_through: string | null;
    day_covered_by_sync: boolean;
    fresh: boolean;
  };
  /** 仅是本次响应的生成时间，不代表任何同步水位 */
  generated_at: string;
};


function buildStore(input: GoStoreInput): GoStoreOut {
  if (input.status === "error") {
    return {
      location_id: input.location_id,
      name: input.name,
      status: "error",
      target_fen: null,
      actual_fen: null,
      gap_fen: null,
      order_count: null,
      breakdown: { youzan_fen: null, offline_fen: null, offline_entry_count: null },
      completeness: {
        complete: false,
        kind: "paid_gross",
        refunds_complete: false,
        reasons: [input.code, ...(input.message ? [input.message] : [])],
        youzan_synced_through: null,
        day_covered_by_sync: false,
        source_fresh: false,
      },
      freshness: { synced_through: null, day_covered_by_sync: false, fresh: false },
    };
  }


  const reasons: string[] = [];
  let complete = true;

  if (!input.youzan_bound) {
    reasons.push("location_not_bound_to_youzan_shop");
    complete = false;
  }
  if (!input.has_refund_source) {
    reasons.push("refund_source_unavailable");
    complete = false;
  }
  if (!input.has_current_day_snapshot) {
    reasons.push("sync_window_not_covered");
    complete = false;
  } else if (!input.source_fresh) {
    reasons.push("youzan_snapshot_stale");
    complete = false;
  }

  const youzan = input.youzan_fen;
  const offline = input.offline_fen;

  // 当天没有被成功同步窗口覆盖，而有赞侧又一分钱都没有 → 没有证据，不能报 0
  const noYouzanEvidence = !input.has_current_day_snapshot && (youzan == null || youzan === 0);
  const actual =
    youzan == null || offline == null
      ? null
      : noYouzanEvidence && offline === 0
        ? null
        : youzan + offline;

  const orderCount =
    actual == null || input.youzan_order_count == null || input.offline_order_count == null
      ? null
      : input.youzan_order_count + input.offline_order_count;

  return {
    location_id: input.location_id,
    name: input.name,
    status: "ok",
    target_fen: input.target_fen,
    actual_fen: actual,
    gap_fen: gapFen(input.target_fen, actual),
    order_count: orderCount,
    breakdown: {
      youzan_fen: youzan,
      offline_fen: offline,
      offline_entry_count: input.offline_entry_count,
    },
    completeness: {
      complete,
      // 本地没有有赞退款数据源，只要缺退款源就只能是已付款毛额口径
      kind: input.has_refund_source ? "net" : "paid_gross",
      refunds_complete: input.has_refund_source,
      reasons,
      youzan_synced_through: input.youzan_synced_through,
      day_covered_by_sync: input.day_covered_by_sync,
      source_fresh: input.source_fresh,
    },
    freshness: {
      synced_through: input.youzan_synced_through,
      day_covered_by_sync: input.day_covered_by_sync,
      fresh: input.source_fresh,
    },
  };
}


export function buildGoDailySummary(params: {
  date: string;
  scope: { mode: GoScopeMode; locationIds: string[]; todayLocationId: string | null };
  stores: GoStoreInput[];
  generatedAt: string;
}): GoDailySummary {
  const stores = params.stores.map(buildStore);

  const target = sumNullable(stores.map((s) => s.target_fen));
  const actual = sumNullable(stores.map((s) => s.actual_fen));

  const reasons = new Set<string>();
  let complete = stores.length > 0;
  let kind: "paid_gross" | "net" = "net";
  let refundsComplete = stores.length > 0;
  let dayCovered = stores.length > 0;
  let fresh = stores.length > 0;
  let syncedThrough: string | null | undefined = undefined;
  for (const s of stores) {
    if (!s.completeness.complete) complete = false;
    if (s.completeness.kind === "paid_gross") kind = "paid_gross";
    if (!s.completeness.refunds_complete) refundsComplete = false;
    if (!s.freshness.day_covered_by_sync) dayCovered = false;
    if (!s.freshness.fresh) fresh = false;
    // 最保守水位：任一门店未知即整体未知，否则取最早
    if (s.freshness.synced_through == null) syncedThrough = null;
    else if (syncedThrough !== null) {
      syncedThrough =
        syncedThrough === undefined || s.freshness.synced_through < syncedThrough
          ? s.freshness.synced_through
          : syncedThrough;
    }
    for (const r of s.completeness.reasons) reasons.add(r);
  }
  if (stores.length === 0) reasons.add("no_locations_in_scope");

  return {
    date: params.date,
    scope: {
      mode: params.scope.mode,
      location_ids: params.scope.locationIds,
      today_location_id: params.scope.todayLocationId,
    },
    totals: {
      target_fen: target,
      actual_fen: actual,
      gap_fen: gapFen(target, actual),
      order_count: sumNullable(stores.map((s) => s.order_count)),
      store_count: stores.length,
    },
    stores,
    completeness: { complete, kind, refunds_complete: refundsComplete, reasons: [...reasons] },
    freshness: {
      synced_through: syncedThrough ?? null,
      day_covered_by_sync: dayCovered,
      fresh,
    },
    generated_at: params.generatedAt,
  };
}

