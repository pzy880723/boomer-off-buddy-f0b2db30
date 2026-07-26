import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  Boxes,
  CheckCircle2,
  Clock3,
  Globe2,
  PackageCheck,
  RefreshCw,
  ScanLine,
  ShoppingBag,
  Store,
  WalletCards,
} from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getCommerceOperationsSummary } from "@/lib/commerce-operations.functions";

export const Route = createFileRoute("/shop-mgmt/commerce")({
  head: () => ({ meta: [{ title: "网店运营中心 · BOOMER OFF" }] }),
  component: CommerceOperationsPage,
});

const channelLabel = {
  storefront: "自营网店",
  pos: "门店收银",
  youzan: "有赞",
  manual: "人工订单",
} as const;

const orderStatusLabel: Record<string, string> = {
  pending_payment: "待付款",
  confirmed: "待履约",
  processing: "履约中",
  completed: "已完成",
  cancelled: "已取消",
  after_sale: "售后中",
  closed: "已关闭",
};

function money(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
  }).format(value);
}

function CommerceOperationsPage() {
  const summaryFn = useServerFn(getCommerceOperationsSummary);
  const query = useQuery({
    queryKey: ["commerce-operations-summary"],
    queryFn: () => summaryFn(),
  });
  const data = query.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title="网店运营中心"
        description="自营网店、门店收银和有赞兼容渠道共用一套 ERP 商品、库存、订单与支付账本。"
        actions={
          <Button variant="outline" size="sm" onClick={() => query.refetch()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            刷新
          </Button>
        }
      />

      <section className="overflow-hidden rounded-2xl bg-[#0a315d] p-6 text-white shadow-[0_6px_20px_rgba(10,49,93,0.16)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm text-white/70">
              <CheckCircle2 className="h-4 w-4 text-[#6ce9a6]" />
              统一商业中台
            </div>
            <h2 className="mt-2 text-2xl font-bold tracking-tight">ERP 是唯一商品与库存主数据源</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-white/65">
              自营网店是长期主渠道；门店收银直接扣减本地库存；有赞仅保留同步与迁移期间兼容。
            </p>
          </div>
          <Button asChild className="rounded-xl bg-white text-[#0a315d] hover:bg-white/90">
            <Link to="/shop-mgmt/online">
              管理网店商品
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            {
              label: "已上架商品",
              value: data?.stats.published_listings ?? "—",
              icon: ShoppingBag,
            },
            {
              label: "待付款订单",
              value: data?.stats.pending_payment ?? "—",
              icon: Clock3,
            },
            {
              label: "待履约订单",
              value: data?.stats.pending_fulfillment ?? "—",
              icon: PackageCheck,
            },
            {
              label: "今日成交额",
              value: data ? money(data.stats.today_gmv) : "—",
              icon: WalletCards,
            },
          ].map((stat) => (
            <div key={stat.label} className="rounded-xl bg-white/10 p-4 backdrop-blur-sm">
              <stat.icon className="h-4 w-4 text-white/70" />
              <div className="mt-3 text-2xl font-bold tabular-nums">{stat.value}</div>
              <div className="mt-1 text-xs text-white/60">{stat.label}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="rounded-2xl border-[#e4e7ec] shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <Globe2 className="h-5 w-5 text-[#0a315d]" />
                自营网店
              </CardTitle>
              <Badge className="bg-[#ecfdf3] text-[#067647] hover:bg-[#ecfdf3]">主渠道</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm leading-6 text-muted-foreground">
              商品浏览、分类、购物车、下单、库存预占和门店履约均走 BOOMER API。
            </p>
            <div className="flex items-center justify-between rounded-xl bg-muted/50 p-3 text-sm">
              <span>累计订单</span>
              <span className="font-semibold tabular-nums">
                {data?.channels.storefront_orders ?? "—"}
              </span>
            </div>
            <Button asChild variant="outline" className="w-full rounded-xl">
              <Link to="/orders/online">查看网店订单</Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-[#e4e7ec] shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <ScanLine className="h-5 w-5 text-[#e8343a]" />
                门店收银
              </CardTitle>
              <Badge variant="outline">统一订单</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm leading-6 text-muted-foreground">
              扫码、组合支付、库存扣减、小票与交班对账进入同一销售账本。
            </p>
            <div className="flex items-center justify-between rounded-xl bg-muted/50 p-3 text-sm">
              <span>累计订单</span>
              <span className="font-semibold tabular-nums">{data?.channels.pos_orders ?? "—"}</span>
            </div>
            <Button asChild className="w-full rounded-xl bg-[#e8343a] hover:bg-[#c92930]">
              <Link to="/pos">进入门店收银</Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-[#e4e7ec] shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <Store className="h-5 w-5 text-[#667085]" />
                有赞兼容渠道
              </CardTitle>
              <Badge variant="secondary">迁移适配器</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm leading-6 text-muted-foreground">
              保留库存和订单同步能力，不再承担商品、库存或支付主数据职责。
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-[#fffaeb] p-3">
                <div className="text-lg font-semibold tabular-nums text-[#b54708]">
                  {data?.channels.youzan_sync_pending ?? "—"}
                </div>
                <div className="text-xs text-[#b54708]">待同步</div>
              </div>
              <div className="rounded-xl bg-[#fef3f2] p-3">
                <div className="text-lg font-semibold tabular-nums text-[#b42318]">
                  {data?.channels.youzan_sync_failed ?? "—"}
                </div>
                <div className="text-xs text-[#b42318]">同步失败</div>
              </div>
            </div>
            <Button asChild variant="outline" className="w-full rounded-xl">
              <Link to="/youzan/sync">查看同步队列</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <Card className="overflow-hidden rounded-2xl border-[#e4e7ec] shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">最近订单</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link to="/orders/online">
                全部订单
                <ArrowRight className="ml-1.5 h-4 w-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>订单号</TableHead>
                  <TableHead>渠道</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">金额</TableHead>
                  <TableHead>时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.recent_orders ?? []).map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-mono text-xs">{order.order_no}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {channelLabel[order.source_channel] ?? order.source_channel}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {orderStatusLabel[order.order_status] ?? order.order_status}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {money(Number(order.total_amount))}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(order.created_at).toLocaleString("zh-CN")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!query.isLoading && (data?.recent_orders.length ?? 0) === 0 && (
              <div className="py-12 text-center text-sm text-muted-foreground">暂无最近订单</div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-[#e4e7ec] shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
          <CardHeader>
            <CardTitle className="text-base">商品结构</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              { label: "自定义商品", value: data?.listing_types.custom, icon: ShoppingBag },
              { label: "组包商品", value: data?.listing_types.bundle, icon: Boxes },
              { label: "标准商品", value: data?.listing_types.standard, icon: PackageCheck },
            ].map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between rounded-xl border border-[#eaecf0] p-3"
              >
                <div className="flex items-center gap-2 text-sm">
                  <item.icon className="h-4 w-4 text-[#667085]" />
                  {item.label}
                </div>
                <span className="font-semibold tabular-nums">{item.value ?? "—"}</span>
              </div>
            ))}
            {(data?.channels.youzan_sync_failed ?? 0) > 0 && (
              <div className="flex gap-2 rounded-xl bg-[#fef3f2] p-3 text-xs leading-5 text-[#b42318]">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                有赞存在同步失败任务，但不会影响自营网店和门店收银。
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
