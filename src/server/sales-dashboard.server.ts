/**
 * 销售仪表盘数据装配（服务端专用）。
 * 只做读取与口径归一，不写库、不触发有赞/库存动作。
 * 任何来源失败都会转成 warning + null，绝不吞成 0。
 */
import { shanghaiDayWindow } from "@/lib/store-targets/sales-window";
import {
  type ChannelKey,
  type DashboardWarning,
  type LocationScope,
  type ResolvedRange,
  addDays,
  avgOrderValueFen,
  evaluateSourceStale,
  refundWarnings,
  sumMoney,
  trendWindow,
} from "@/lib/sales-dashboard/contract";

export type DashboardChannel = {
  key: ChannelKey;
  label: string;
  net_sales_fen: number | null;
  order_count: number | null;
  refund_fen: number | null;
  refund_source: "available" | "unavailable";
};

export type DashboardTodo = {
  pending_pick: number;
  pending_ship: number;
  shortage_pending_customer: number;
  after_sales_open: number;
  support_unanswered: number;
  sync_failed: number;
};

export type SalesDashboardResult = {
  range: ResolvedRange;
  scope: {
    mode: "all" | "single";
    location_id: string | null;
    locations: { id: string; name: string }[];
  };
  metrics: {
    net_sales_fen: number | null;
    order_count: number | null;
    items_sold: number | null;
    avg_order_value_fen: number | null;
  };
  channels: DashboardChannel[];
  trend: { date: string; net_sales_fen: number | null; order_count: number | null }[];
  sources: {
    key: ChannelKey;
    last_synced_at: string | null;
    watermark: string | null;
    stale: boolean;
  }[];
  todo: DashboardTodo | null;
  warnings: DashboardWarning[];
  generated_at: string;
};

const CHANNEL_LABELS: Record<ChannelKey, string> = {
  pos: "门店 POS",
  storefront: "自有商城",
  youzan: "有赞",
};

type RpcChannel = {
  gross_fen: number | null;
  refund_fen: number | null;
  net_sales_fen: number | null;
  order_count: number | null;
};

type RpcReport = {
  pos: RpcChannel;
  storefront: RpcChannel;
  youzan: RpcChannel & { items?: number | null };
  items_sold: number | null;
  trend: { date: string; net_sales_fen: number; order_count: number }[];
  todo: DashboardTodo;
  watermarks: {
    commerce_last_paid_at: string | null;
    youzan_last_paid_at: string | null;
    youzan_last_synced_at: string | null;
  };
};

const num = (v: unknown): number | null => (v == null ? null : Number(v));

export async function loadSalesDashboard(params: {
  range: ResolvedRange;
  scope: LocationScope;
  locations: { id: string; name: string; shop_id: string | null }[];
  now?: Date;
}): Promise<SalesDashboardResult> {
  const now = params.now ?? new Date();
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const startUtc = shanghaiDayWindow(params.range.start).startUtc;
  const endUtc = shanghaiDayWindow(params.range.end).endUtc;
  const trend = trendWindow(params.range.end);
  const trendStartUtc = shanghaiDayWindow(trend.start).startUtc;

  const scopedLocations = params.locations.filter(
    (l) => params.scope.locationIds.length === 0 || params.scope.locationIds.includes(l.id),
  );
  const shopIds = scopedLocations.map((l) => l.shop_id).filter((v): v is string => !!v);

  const warnings: DashboardWarning[] = [];
  let report: RpcReport | null = null;

  const { data, error } = await supabaseAdmin.rpc("sales_dashboard_report", {
    p_location_ids: params.scope.locationIds,
    p_shop_ids: shopIds,
    p_include_unassigned: params.scope.includeUnassigned,
    p_start: startUtc,
    p_end: endUtc,
    p_trend_start: trendStartUtc,
  } as never);

  if (error) {
    warnings.push({
      code: "aggregation_failed",
      message: `销售聚合查询失败：${error.message}`,
      scope: "metrics",
    });
  } else {
    report = data as unknown as RpcReport;
  }

  const channels: DashboardChannel[] = (["pos", "storefront", "youzan"] as ChannelKey[]).map(
    (key) => {
      const raw = report ? (report[key] as RpcChannel) : null;
      const refundSource: "available" | "unavailable" =
        key === "youzan" ? "unavailable" : "available";
      return {
        key,
        label: CHANNEL_LABELS[key],
        // 有赞没有退款数据源：净销售不可断言，返回 null
        net_sales_fen: raw && refundSource === "available" ? num(raw.net_sales_fen) : null,
        order_count: raw ? num(raw.order_count) : null,
        refund_fen: raw && refundSource === "available" ? num(raw.refund_fen) : null,
        refund_source: refundSource,
      };
    },
  );
  warnings.push(
    ...refundWarnings(channels.map((c) => ({ key: c.key, refundSource: c.refund_source }))),
  );

  const netSales = sumMoney(channels.map((c) => c.net_sales_fen));
  const orderCount = channels.some((c) => c.order_count == null)
    ? null
    : channels.reduce<number>((s, c) => s + (c.order_count as number), 0);
  const itemsSold = report ? num(report.items_sold) : null;

  const trendRows = new Map((report?.trend ?? []).map((r) => [r.date, r]));
  const trendOut = trend.dates.map((date) => {
    const row = trendRows.get(date);
    // 有赞退款不可得，因此趋势值同样只能视为「含有赞毛额」的近似 → 若聚合失败则 null
    return {
      date,
      net_sales_fen: row ? num(row.net_sales_fen) : null,
      order_count: row ? num(row.order_count) : null,
    };
  });
  if (!report) {
    warnings.push({ code: "trend_unavailable", message: "趋势数据不可用", scope: "trend" });
  }

  const youzanSyncedAt = report?.watermarks.youzan_last_synced_at ?? null;
  const sources: SalesDashboardResult["sources"] = [
    {
      key: "pos",
      last_synced_at: report?.watermarks.commerce_last_paid_at ?? null,
      watermark: report?.watermarks.commerce_last_paid_at ?? null,
      stale: false,
    },
    {
      key: "storefront",
      last_synced_at: report?.watermarks.commerce_last_paid_at ?? null,
      watermark: report?.watermarks.commerce_last_paid_at ?? null,
      stale: false,
    },
    {
      key: "youzan",
      last_synced_at: youzanSyncedAt,
      watermark: report?.watermarks.youzan_last_paid_at ?? null,
      stale: evaluateSourceStale({ key: "youzan", lastSyncedAt: youzanSyncedAt }, endUtc, now),
    },
  ];
  if (sources[2].stale) {
    warnings.push({
      code: "youzan_sync_stale",
      message: `有赞同步落后（最近成功同步：${youzanSyncedAt ?? "无记录"}），有赞金额可能不完整`,
      scope: "channel",
    });
  }

  const todo = report?.todo ?? null;
  if (!todo) warnings.push({ code: "todo_unavailable", message: "待办统计不可用", scope: "todo" });

  return {
    range: params.range,
    scope: {
      mode: params.scope.mode,
      location_id: params.scope.locationId,
      locations: scopedLocations.map((l) => ({ id: l.id, name: l.name })),
    },
    metrics: {
      net_sales_fen: netSales,
      order_count: orderCount,
      items_sold: itemsSold,
      avg_order_value_fen: avgOrderValueFen(netSales, orderCount),
    },
    channels,
    trend: trendOut,
    sources,
    todo: todo
      ? {
          pending_pick: Number(todo.pending_pick ?? 0),
          pending_ship: Number(todo.pending_ship ?? 0),
          shortage_pending_customer: Number(todo.shortage_pending_customer ?? 0),
          after_sales_open: Number(todo.after_sales_open ?? 0),
          support_unanswered: Number(todo.support_unanswered ?? 0),
          sync_failed: Number(todo.sync_failed ?? 0),
        }
      : null,
    warnings,
    generated_at: now.toISOString(),
  };
}

export const __testables = { addDays };
