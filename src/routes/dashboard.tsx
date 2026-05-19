import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { DollarSign, CalendarRange, Wallet, ArrowRight, Mail, Plane, ShoppingBag, PackageCheck } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { MetricCard } from "@/components/metric-card";
import { getPurchaseStats, type ChannelKey } from "@/lib/dashboard.functions";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "仪表盘 · BOOMER OFF" },
      { name: "description", content: "累计采购金额与分渠道统计总览" },
    ],
  }),
  component: DashboardPage,
});

const CHANNEL_META: Record<ChannelKey, { icon: typeof Mail; to: string; unit: string }> = {
  japan_parcel: { icon: Mail, to: "/purchase/japan-parcel", unit: "单" },
  japan_bulk: { icon: Plane, to: "/purchase/japan-bulk", unit: "票" },
  domestic: { icon: ShoppingBag, to: "/purchase/domestic", unit: "单" },
  domestic_bulk: { icon: PackageCheck, to: "/purchase/domestic-bulk", unit: "单" },
};

function fmt(n: number) {
  return `¥${Math.round(n).toLocaleString("zh-CN")}`;
}

function DashboardPage() {
  const fetchStats = useServerFn(getPurchaseStats);
  const { data, isLoading, error } = useQuery({
    queryKey: ["purchase-stats"],
    queryFn: () => fetchStats(),
  });

  return (
    <div>
      <PageHeader
        title="仪表盘"
        description="累计采购金额与分渠道统计总览"
        meta={<span>当前周期 · {new Date().getFullYear()} 年</span>}
      />

      {error && (
        <Card className="mb-4 border-destructive/40">
          <CardContent className="p-4 text-sm text-destructive">
            数据加载失败：{(error as Error).message}
          </CardContent>
        </Card>
      )}

      {/* 累计采购金额 */}
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        {isLoading || !data ? (
          <>
            <Skeleton className="h-32 rounded-lg" />
            <Skeleton className="h-32 rounded-lg" />
            <Skeleton className="h-32 rounded-lg" />
          </>
        ) : (
          <>
            <MetricCard title="本月累计采购" value={fmt(data.totals.month)} icon={DollarSign} tone="brand" hint="按下单日期统计" />
            <MetricCard title="本年度累计采购" value={fmt(data.totals.ytd)} icon={CalendarRange} hint={`${new Date().getFullYear()} 全年至今`} />
            <MetricCard title="累计采购金额" value={fmt(data.totals.all)} icon={Wallet} hint={`总计 ${data.totals.count} 单`} />
          </>
        )}
      </div>

      {/* 分渠道统计 */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {isLoading || !data
          ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-56 rounded-lg" />)
          : data.byChannel.map((c) => {
              const meta = CHANNEL_META[c.key];
              const Icon = meta.icon;
              return (
                <Card key={c.key} className="transition-shadow hover:shadow-card-hover">
                  <CardHeader className="flex flex-row items-start justify-between pb-3">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-accent text-accent-foreground">
                        <Icon className="h-4 w-4" />
                      </div>
                      <div>
                        <CardTitle className="text-base">{c.label}</CardTitle>
                        <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                          {c.count} {meta.unit}
                          {c.placeholder && (
                            <span className="ml-1.5 inline-flex">
                              <Badge variant="outline" className="text-[10px]">待接入</Badge>
                            </span>
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
                  <CardContent className="space-y-2.5">
                    <Row label="本月" value={fmt(c.month)} />
                    <Row label="本年度" value={fmt(c.ytd)} />
                    <Row label="累计" value={fmt(c.all)} strong />
                  </CardContent>
                </Card>
              );
            })}
      </div>

      {/* 近 12 个月趋势 */}
      <Card>
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
                <YAxis tickLine={false} axisLine={false} fontSize={11} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Legend />
                <Bar dataKey="japan_parcel" stackId="a" fill="var(--color-chart-1)" />
                <Bar dataKey="japan_bulk" stackId="a" fill="var(--color-chart-2)" />
                <Bar dataKey="domestic" stackId="a" fill="var(--color-chart-3)" />
                <Bar dataKey="domestic_bulk" stackId="a" fill="var(--color-chart-4)" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>
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
