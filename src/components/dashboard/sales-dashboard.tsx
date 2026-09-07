import { useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Boxes,
  ClipboardList,
  Package,
  RefreshCw,
  ShoppingBag,
  Store,
  TrendingUp,
  Truck,
  Wallet,
} from "lucide-react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import {
  dashboardRange,
  displayAmount,
  displayCount,
  validateDashboardRange,
  type DashboardDisplay,
  type DashboardPeriod,
  type DashboardRange,
} from "@/lib/dashboard-view";

type Props = {
  data?: DashboardDisplay;
  loading: boolean;
  refreshing: boolean;
  error?: string;
  range: DashboardRange;
  period: DashboardPeriod | "custom";
  onRange: (range: DashboardRange, period: DashboardPeriod | "custom") => void;
  locations: Array<{ id: string; name: string }>;
  isHq: boolean;
  locationId: string;
  onLocation: (id: string) => void;
  onRefresh: () => void;
};

const actions = [
  { label: "门店收银", description: "扫码收款", href: "/pos", icon: Wallet },
  { label: "商品库", description: "商品与价格组", href: "/inventory/skus", icon: ShoppingBag },
  { label: "订单", description: "查看与备货", href: "/orders/online", icon: ClipboardList },
  { label: "包裹", description: "到货与拆包", href: "/purchase/japan-parcel", icon: Package },
  { label: "入库", description: "查看入库单", href: "/inventory/inbound", icon: Boxes },
  { label: "调拨", description: "门店间流转", href: "/inventory/transfers", icon: Truck },
];

export function SalesDashboard(props: Props) {
  const { data, range, loading, refreshing, error } = props;
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState(range);
  const [dateError, setDateError] = useState<string | null>(null);
  const metrics = data
    ? [
        {
          label: "销售额",
          value: displayAmount(data.metrics.netSalesFen),
          hint: "实收减成功退款",
          icon: Wallet,
        },
        {
          label: "成交订单",
          value: displayCount(data.metrics.orders),
          hint: "已同步的支付订单 · 单",
          icon: ClipboardList,
        },
        {
          label: "售出件数",
          value: displayCount(data.metrics.units),
          hint: "已同步的支付商品 · 件",
          icon: ShoppingBag,
        },
        {
          label: "客单价",
          value: displayAmount(data.metrics.aovFen),
          hint: "销售额 ÷ 成交订单",
          icon: TrendingUp,
        },
      ]
    : [];
  const hasNetTrend = data?.trend.every((day) => day.netSalesFen !== null) ?? false;
  const trend =
    data?.trend.map((day) => ({
      date: day.date,
      amount: (hasNetTrend ? day.netSalesFen! : day.grossPaidFen) / 100,
    })) ?? [];
  const allZero = trend.length > 0 && trend.every((day) => day.amount === 0);

  return (
    <div className="space-y-6" data-testid="sales-dashboard">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">经营概况</p>
          <h1 className="text-2xl font-semibold tracking-tight">仪表盘</h1>
          <p className="mt-2 text-sm text-muted-foreground">今天卖得怎么样，还有哪些事要处理。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-h-10 items-center gap-2 rounded-lg border bg-card px-3 text-sm">
            <Store aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
            <span className="sr-only">统计门店</span>
            <select
              aria-label="统计门店"
              className="max-w-[220px] bg-transparent py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={props.locationId}
              onChange={(e) => props.onLocation(e.target.value)}
              disabled={!props.locations.length}
            >
              {props.isHq && <option value="all">全部门店与总部</option>}
              {!props.locations.length && <option value="">正在读取授权门店</option>}
              {props.locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="outline"
            onClick={props.onRefresh}
            disabled={refreshing}
            aria-label="刷新仪表盘"
          >
            <RefreshCw className={`mr-1.5 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "更新中" : "刷新"}
          </Button>
        </div>
      </header>

      <section aria-label="统计日期" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1 rounded-lg border bg-card p-1">
            {(
              [
                ["today", "今天"],
                ["yesterday", "昨天"],
                ["month", "本月"],
              ] as const
            ).map(([period, label]) => (
              <Button
                key={period}
                size="sm"
                variant={props.period === period ? "default" : "ghost"}
                aria-pressed={props.period === period}
                onClick={() => {
                  props.onRange(dashboardRange(period), period);
                  setCustomOpen(false);
                  setDateError(null);
                }}
              >
                {label}
              </Button>
            ))}
            <Button
              size="sm"
              variant={props.period === "custom" || customOpen ? "default" : "ghost"}
              aria-expanded={customOpen}
              onClick={() => {
                setDraft(range);
                setCustomOpen(!customOpen);
                setDateError(null);
              }}
            >
              自选日期
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {range.start} {range.start !== range.end && `至 ${range.end}`} · 北京时间
          </p>
        </div>
        {customOpen && (
          <form
            className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3"
            onSubmit={(e) => {
              e.preventDefault();
              const issue = validateDashboardRange(draft);
              setDateError(issue);
              if (!issue) {
                props.onRange(draft, "custom");
                setCustomOpen(false);
              }
            }}
          >
            <label className="space-y-1 text-xs text-muted-foreground">
              <span className="block">开始日期</span>
              <input
                required
                type="date"
                className="h-10 min-w-0 rounded-md border bg-background px-3 text-sm text-foreground"
                value={draft.start}
                onChange={(e) => setDraft({ ...draft, start: e.target.value })}
              />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              <span className="block">结束日期</span>
              <input
                required
                type="date"
                className="h-10 min-w-0 rounded-md border bg-background px-3 text-sm text-foreground"
                value={draft.end}
                onChange={(e) => setDraft({ ...draft, end: e.target.value })}
              />
            </label>
            <Button type="submit">应用日期</Button>
            {dateError && (
              <p role="alert" className="w-full text-sm text-destructive">
                {dateError}
              </p>
            )}
          </form>
        )}
      </section>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
        >
          <span>
            加载失败：{error}。{data ? "以下为上次读取的数据。" : "请重试，不代表没有销售。"}
          </span>
          <Button size="sm" variant="outline" onClick={props.onRefresh} disabled={refreshing}>
            重试
          </Button>
        </div>
      )}

      {loading && !data ? (
        <div aria-label="正在加载经营数据" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : (
        data && (
          <>
            {data.warnings.length > 0 && (
              <div
                className="rounded-lg border border-amber-300/50 bg-amber-50/60 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"
                role="status"
              >
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-medium">部分数据待核对，暂不作为完整结算依据</p>
                    <ul className="mt-1 space-y-1 text-xs leading-relaxed">
                      {data.warnings.map((warning, i) => (
                        <li key={i}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}
            <section aria-label="销售指标" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              {metrics.map((metric, i) => (
                <Card key={metric.label} className="rounded-xl shadow-sm">
                  <CardContent className="p-4 sm:p-5">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="text-sm text-muted-foreground">{metric.label}</h2>
                      <metric.icon aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <p
                      className={`mt-4 break-words text-2xl font-semibold tracking-tight tabular-nums lg:text-3xl ${i === 0 ? "text-primary" : ""}`}
                    >
                      {metric.value}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">{metric.hint}</p>
                    {i === 0 && data.metrics.netSalesFen === null && (
                      <p className="mt-2 text-xs">
                        已知实收 {displayAmount(data.metrics.grossPaidFen)}
                        <span className="text-muted-foreground">（未扣全量退款）</span>
                      </p>
                    )}
                  </CardContent>
                </Card>
              ))}
            </section>
            <details className="rounded-lg border bg-card px-4 py-3 text-sm">
              <summary className="cursor-pointer font-medium">
                销售渠道明细{" "}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  收银台 / 网店 / 有赞
                </span>
              </summary>
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                {data.channels.map((channel) => (
                  <div key={channel.key}>
                    <p className="text-xs text-muted-foreground">{channel.label}</p>
                    <p className="mt-1 font-semibold tabular-nums">
                      {displayAmount(channel.netSalesFen)}
                    </p>
                    {channel.netSalesFen === null && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        已知实收 {displayAmount(channel.grossPaidFen)} · 退款待核对
                      </p>
                    )}
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
                按付款日期归属，金额包含运费；已成功退款回扣原订单。售出件数为成交件数，未扣退货。
              </p>
            </details>
            <section aria-labelledby="dashboard-tasks">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="dashboard-tasks" className="font-semibold">
                  待处理事项
                </h2>
                <span className="text-xs text-muted-foreground">当前待办，不受销售日期影响</span>
              </div>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
                {data.tasks.map((task) => (
                  <a
                    href={task.href}
                    key={task.key}
                    className="group rounded-xl border bg-card p-4 shadow-sm transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <p className="text-xs text-muted-foreground">{task.label}</p>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <span
                        className={`text-xl font-semibold tabular-nums ${task.count && task.count > 0 ? "text-primary" : ""}`}
                      >
                        {displayCount(task.count)}
                      </span>
                      <ArrowRight
                        aria-hidden="true"
                        className="h-4 w-4 text-muted-foreground group-hover:text-primary"
                      />
                    </div>
                  </a>
                ))}
              </div>
            </section>
          </>
        )
      )}

      <section aria-labelledby="dashboard-actions">
        <h2 id="dashboard-actions" className="mb-3 font-semibold">
          常用操作
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {actions
            .filter((action) => props.isHq || action.href !== "/purchase/japan-parcel")
            .map((action) => (
              <a
                href={action.href}
                key={action.label}
                className="group flex items-center gap-3 rounded-xl border bg-card p-4 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <action.icon aria-hidden="true" className="h-5 w-5 shrink-0 text-primary" />
                <div className="min-w-0">
                  <span className="text-sm font-medium">{action.label}</span>
                  <p className="mt-0.5 text-xs text-muted-foreground">{action.description}</p>
                </div>
              </a>
            ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          拍照上架与蓝牙打印请在 ERP App 操作；网页商品库可查看和打印标签。
        </p>
      </section>

      {data && (
        <Card className="rounded-xl shadow-sm">
          <CardContent className="p-4 sm:p-5">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="font-semibold">近 7 天销售趋势</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  截至 {range.end} · {data.scopeLabel} ·{" "}
                  {hasNetTrend ? "净销售额" : "已知实收，未扣全量退款"}
                </p>
              </div>
              {allZero && (
                <span className="text-xs text-muted-foreground">该范围内暂无已同步的成交金额</span>
              )}
            </div>
            <ChartContainer
              config={{
                amount: {
                  label: hasNetTrend ? "销售额（元）" : "已知实收（元）",
                  color: "var(--color-primary)",
                },
              }}
              className="h-[240px] w-full sm:h-[280px]"
            >
              <LineChart
                accessibilityLayer
                data={trend}
                margin={{ left: 4, right: 16, top: 10, bottom: 0 }}
              >
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(date) => date.slice(5)}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={8}
                />
                <YAxis
                  width={55}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) =>
                    Math.abs(value) >= 10000 ? `${value / 10000}万` : `${value}`
                  }
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Line
                  type="linear"
                  dataKey="amount"
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ChartContainer>
          </CardContent>
        </Card>
      )}
      <footer
        aria-live="polite"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-4 text-xs text-muted-foreground"
      >
        <span>{data?.scopeLabel ?? "正在读取门店范围"}</span>
        <span>
          {data
            ? `读取时间：${new Date(data.fetchedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`
            : "尚未取得数据"}
        </span>
        <span>读取时间不等于外部渠道同步完成时间</span>
      </footer>
    </div>
  );
}
