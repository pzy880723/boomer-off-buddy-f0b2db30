import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  DollarSign,
  CalendarRange,
  Wallet,
  ArrowRight,
  Mail,
  Plane,
  ShoppingBag,
  PackageCheck,
  Activity,
  PackageSearch,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { MetricCard } from "@/components/metric-card";
import { getPurchaseStats, type ChannelKey, type ChannelStat } from "@/lib/dashboard.functions";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "仪表盘 · BOOMER OFF" },
      { name: "description", content: "累计采购金额与分渠道统计总览" },
    ],
  }),
  component: DashboardPage,
});

type Period = "month" | "ytd" | "all";

const CHANNEL_META: Record<
  ChannelKey,
  { icon: typeof Mail; to: string; unit: string; color: string }
> = {
  japan_parcel: { icon: Mail, to: "/purchase/japan-parcel", unit: "单", color: "var(--color-chart-1)" },
  japan_bulk: { icon: Plane, to: "/purchase/japan-bulk", unit: "票", color: "var(--color-chart-2)" },
  domestic: { icon: ShoppingBag, to: "/purchase/domestic", unit: "单", color: "var(--color-chart-3)" },
  domestic_bulk: { icon: PackageCheck, to: "/purchase/domestic-bulk", unit: "单", color: "var(--color-chart-4)" },
};

function fmt(n: number) {
  if (!n) return "¥0";
  if (n >= 10000) return `¥${(n / 10000).toFixed(n >= 100000 ? 1 : 2)}万`;
  return `¥${Math.round(n).toLocaleString("zh-CN")}`;
}
function fmtFull(n: number) {
  return `¥${Math.round(n).toLocaleString("zh-CN")}`;
}
function pickAmount(c: ChannelStat, p: Period) {
  return p === "month" ? c.month : p === "ytd" ? c.ytd : c.all;
}
function relTime(ts: string) {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function DashboardPage() {
  const fetchStats = useServerFn(getPurchaseStats);
  const { data, isLoading, error } = useQuery({
    queryKey: ["purchase-stats"],
    queryFn: () => fetchStats(),
  });
  const [period, setPeriod] = useState<Period>("month");

  const channelsForPeriod = useMemo(() => {
    if (!data) return [];
    return data.byChannel
      .map((c) => ({ ...c, value: pickAmount(c, period) }))
      .sort((a, b) => b.value - a.value);
  }, [data, period]);

  const totalForPeriod = useMemo(
    () => channelsForPeriod.reduce((s, c) => s + c.value, 0),
    [channelsForPeriod],
  );

  const totalJpStatus = data?.byStatus.reduce((s, b) => s + b.count, 0) ?? 0;

  return (
    <div>
      <PageHeader
        title="仪表盘"
        description="采购金额、渠道分布与状态总览"
        meta={
          <>
            <span>当前周期 · {new Date().getFullYear()} 年</span>
            {data && <span>· 共 {data.totals.count.toLocaleString()} 单采购</span>}
          </>
        }
        actions={
          <Tabs value={period} onValueChange={(v) => setPeriod(v as Period)}>
            <TabsList>
              <TabsTrigger value="month">本月</TabsTrigger>
              <TabsTrigger value="ytd">本年度</TabsTrigger>
              <TabsTrigger value="all">累计</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      {error && (
        <Card className="mb-4 border-destructive/40">
          <CardContent className="p-4 text-sm text-destructive">
            数据加载失败：{(error as Error).message}
          </CardContent>
        </Card>
      )}

      {/* KPI */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {isLoading || !data ? (
          <>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-32 rounded-lg" />
            ))}
          </>
        ) : (
          <>
            <MetricCard
              title="本月采购"
              value={fmtFull(data.totals.month)}
              icon={DollarSign}
              tone="brand"
              hint={`${data.totals.monthCount} 单`}
            />
            <MetricCard
              title="本年度累计"
              value={fmtFull(data.totals.ytd)}
              icon={CalendarRange}
              hint={`${new Date().getFullYear()} 全年至今`}
            />
            <MetricCard
              title="历史累计"
              value={fmtFull(data.totals.all)}
              icon={Wallet}
              hint={`总计 ${data.totals.count} 单`}
            />
            <MetricCard
              title="日本小包在途未签收"
              value={
                (data.byStatus.find((s) => s.key === "purchased")?.count ?? 0) +
                (data.byStatus.find((s) => s.key === "at_jp_warehouse")?.count ?? 0) +
                (data.byStatus.find((s) => s.key === "shipping_intl")?.count ?? 0)
              }
              icon={PackageSearch}
              hint="已采购 + 在日仓 + 国际运输"
            />
          </>
        )}
      </div>

      {/* 趋势 + 渠道占比 */}
      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">近 12 个月采购趋势</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">按渠道堆叠（人民币）</p>
          </CardHeader>
          <CardContent>
            {isLoading || !data ? (
              <Skeleton className="h-[280px] w-full" />
            ) : (
              <ChartContainer
                config={{
                  japan_parcel: { label: "日本小包", color: "var(--color-chart-1)" },
                  japan_bulk: { label: "日本大宗", color: "var(--color-chart-2)" },
                  domestic: { label: "国内小包", color: "var(--color-chart-3)" },
                  domestic_bulk: { label: "国内大宗", color: "var(--color-chart-4)" },
                }}
                className="h-[280px] w-full"
              >
                <BarChart data={data.monthlyTrend}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    tickFormatter={(v) => (v >= 10000 ? `${(v / 10000).toFixed(0)}万` : v)}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="japan_parcel" stackId="a" fill="var(--color-chart-1)" />
                  <Bar dataKey="japan_bulk" stackId="a" fill="var(--color-chart-2)" />
                  <Bar dataKey="domestic" stackId="a" fill="var(--color-chart-3)" />
                  <Bar dataKey="domestic_bulk" stackId="a" fill="var(--color-chart-4)" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">渠道占比</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {period === "month" ? "本月" : period === "ytd" ? "本年度" : "累计"} · {fmt(totalForPeriod)}
            </p>
          </CardHeader>
          <CardContent>
            {isLoading || !data ? (
              <Skeleton className="h-[280px] w-full" />
            ) : totalForPeriod === 0 ? (
              <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
                该周期暂无采购数据
              </div>
            ) : (
              <>
                <ChartContainer config={{}} className="mx-auto h-[160px] w-full">
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                    <Pie
                      data={channelsForPeriod.filter((c) => c.value > 0)}
                      dataKey="value"
                      nameKey="label"
                      innerRadius={42}
                      outerRadius={68}
                      paddingAngle={2}
                    >
                      {channelsForPeriod
                        .filter((c) => c.value > 0)
                        .map((c) => (
                          <Cell key={c.key} fill={CHANNEL_META[c.key].color} />
                        ))}
                    </Pie>
                  </PieChart>
                </ChartContainer>
                <div className="mt-3 space-y-2">
                  {channelsForPeriod.map((c) => {
                    const pct = totalForPeriod ? (c.value / totalForPeriod) * 100 : 0;
                    return (
                      <div key={c.key} className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-sm"
                            style={{ backgroundColor: CHANNEL_META[c.key].color }}
                          />
                          {c.label}
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          {fmt(c.value)} · {pct.toFixed(0)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 渠道卡片 */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {isLoading || !data
          ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-44 rounded-lg" />)
          : data.byChannel.map((c) => {
              const meta = CHANNEL_META[c.key];
              const Icon = meta.icon;
              return (
                <Card key={c.key} className="transition-shadow hover:shadow-card-hover">
                  <CardHeader className="flex flex-row items-start justify-between pb-3">
                    <div className="flex items-center gap-2.5">
                      <div
                        className="flex h-9 w-9 items-center justify-center rounded-md text-white"
                        style={{ backgroundColor: meta.color }}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div>
                        <CardTitle className="text-base">{c.label}</CardTitle>
                        <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                          {c.count} {meta.unit}
                          {c.placeholder && (
                            <Badge variant="outline" className="ml-1.5 text-[10px]">
                              待接入
                            </Badge>
                          )}
                        </p>
                      </div>
                    </div>
                    <Link
                      to={meta.to}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      查看 <ArrowRight className="h-3 w-3" />
                    </Link>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <Row label="本月" value={fmtFull(c.month)} />
                    <Row label="本年度" value={fmtFull(c.ytd)} />
                    <Row label="累计" value={fmtFull(c.all)} strong />
                  </CardContent>
                </Card>
              );
            })}
      </div>

      {/* 状态分布 + 最近动态 */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">日本小包状态分布</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">共 {totalJpStatus} 单</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading || !data ? (
              <Skeleton className="h-40 w-full" />
            ) : totalJpStatus === 0 ? (
              <p className="text-sm text-muted-foreground">暂无数据</p>
            ) : (
              data.byStatus.map((s, i) => {
                const pct = totalJpStatus ? (s.count / totalJpStatus) * 100 : 0;
                const shades = [
                  "var(--color-chart-1)",
                  "var(--color-chart-2)",
                  "var(--color-chart-3)",
                  "var(--color-chart-4)",
                  "var(--color-chart-5)",
                ];
                return (
                  <div key={s.key}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span>{s.label}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {s.count} · {pct.toFixed(0)}%
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${pct}%`, backgroundColor: shades[i % shades.length] }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <div>
              <CardTitle className="text-base">最近动态</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">最近 10 条采购更新</p>
            </div>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading || !data ? (
              <Skeleton className="h-40 w-full" />
            ) : data.recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无动态</p>
            ) : (
              <ul className="divide-y">
                {data.recent.map((r) => {
                  const meta = CHANNEL_META[r.channel];
                  const Icon = meta.icon;
                  return (
                    <li key={`${r.channel}-${r.id}`}>
                      <Link
                        to={meta.to}
                        className="flex items-center gap-3 py-2.5 text-sm transition-colors hover:bg-accent/40"
                      >
                        <div
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-white"
                          style={{ backgroundColor: meta.color }}
                        >
                          <Icon className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{r.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {meta && <span>{CHANNEL_META[r.channel] ? r.channel === "japan_parcel" ? "日本小包" : r.channel === "domestic" ? "国内小包" : "国内大宗" : ""}</span>}
                            <span className="mx-1.5">·</span>
                            <span>{relTime(r.ts)}</span>
                          </p>
                        </div>
                        <div className="shrink-0 text-right tabular-nums">
                          <p className="font-semibold">{fmtFull(r.amount)}</p>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${strong ? "text-base font-semibold" : "font-medium"}`}>{value}</span>
    </div>
  );
}
