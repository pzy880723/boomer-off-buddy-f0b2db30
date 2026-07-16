import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Boxes, PackageOpen, Search, Smartphone } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { listCommerceOrders, type CommerceOrderAdminRow } from "@/lib/commerce-operations.functions";

export const Route = createFileRoute("/orders/online")({
  head: () => ({ meta: [{ title: "网店订单 · BOOMER OFF" }] }),
  component: OnlineOrdersPage,
});

type OrderView = "all" | "pending" | "fulfillment" | "completed" | "after_sale" | "cancelled";

const orderTabs: Array<{ value: OrderView; label: string }> = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待付款" },
  { value: "fulfillment", label: "待履约" },
  { value: "completed", label: "已完成" },
  { value: "after_sale", label: "售后中" },
  { value: "cancelled", label: "已取消" },
];

function orderView(row: CommerceOrderAdminRow): OrderView {
  if (row.order_status === "after_sale") return "after_sale";
  if (row.order_status === "cancelled" || row.order_status === "closed") return "cancelled";
  if (row.order_status === "completed") return "completed";
  if (row.payment_status === "unpaid") return "pending";
  return "fulfillment";
}

const orderStatusLabel: Record<string, string> = {
  pending_payment: "待付款",
  confirmed: "已确认",
  processing: "履约中",
  completed: "已完成",
  cancelled: "已取消",
  after_sale: "售后中",
  closed: "已关闭",
};

const fulfillmentLabel: Record<string, string> = {
  unallocated: "待分配",
  allocated: "待拣货",
  picking: "拣货中",
  picked: "已拣货",
  packing: "打包中",
  packed: "已打包",
  handover_ready: "待交接",
  handed_over: "已交接",
  exception: "异常",
};

function OnlineOrdersPage() {
  const listFn = useServerFn(listCommerceOrders);
  const [view, setView] = useState<OrderView>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: ["commerce-orders", search],
    queryFn: () => listFn({ data: { search: search || undefined } }),
    placeholderData: keepPreviousData,
  });
  const rows = query.data?.rows ?? [];
  const filtered = useMemo(
    () => rows.filter((row) => view === "all" || orderView(row) === view),
    [rows, view],
  );

  return (
    <div>
      <PageHeader
        title="网店订单"
        description="客户一次下单；系统按商品来源门店拆分履约任务，由各门店拣货、打包和发货。"
        meta={<span>当前 {filtered.length} 单 · 全部 {rows.length} 单</span>}
        actions={
          <Button asChild size="sm" variant="outline">
            <Link to="/inventory/devices">
              <Smartphone className="mr-1.5 h-3.5 w-3.5" /> 履约终端
            </Link>
          </Button>
        }
      />

      <Card className="mb-4 rounded-md">
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <Tabs value={view} onValueChange={(value) => setView(value as OrderView)}>
            <TabsList className="h-9">
              {orderTabs.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value}>{tab.label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="relative min-w-72 max-w-lg flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && setSearch(searchInput.trim())}
              placeholder="搜索订单号、收货人、商品或门店"
              className="h-9 pl-8"
            />
          </div>
          <Button size="sm" variant="outline" onClick={() => setSearch(searchInput.trim())}>搜索</Button>
        </CardContent>
      </Card>

      <div className="overflow-hidden rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>订单</TableHead>
              <TableHead>商品</TableHead>
              <TableHead>客户</TableHead>
              <TableHead>门店履约</TableHead>
              <TableHead className="text-right">订单金额</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>下单时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono text-xs">{row.order_no}</TableCell>
                <TableCell>
                  <div className="max-w-72 space-y-1">
                    {row.items.slice(0, 2).map((item) => (
                      <div key={item.id} className="truncate text-sm">{item.title_snapshot}</div>
                    ))}
                    {row.items.length > 2 && <div className="text-xs text-muted-foreground">另 {row.items.length - 2} 件</div>}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="text-sm">{row.recipient_name}</div>
                  <div className="font-mono text-xs text-muted-foreground">{row.recipient_phone}</div>
                </TableCell>
                <TableCell>
                  <div className="space-y-1.5">
                    {row.fulfillments.map((fulfillment) => (
                      <div key={fulfillment.id} className="flex items-center gap-2 text-xs">
                        <span className="min-w-20 truncate">{fulfillment.location?.name ?? "未知门店"}</span>
                        <StatusBadge>{fulfillmentLabel[fulfillment.status] ?? fulfillment.status}</StatusBadge>
                      </div>
                    ))}
                    {row.fulfillments.length === 0 && <span className="text-xs text-muted-foreground">付款后生成</span>}
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono font-medium tabular-nums">¥{Number(row.total_amount).toFixed(2)}</TableCell>
                <TableCell><StatusBadge>{orderStatusLabel[row.order_status] ?? row.order_status}</StatusBadge></TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(row.created_at).toLocaleString("zh-CN")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!query.isLoading && filtered.length === 0 && (
          <EmptyState icon={PackageOpen} title="暂无网店订单" description="App 与自研网店订单会统一进入这里。" />
        )}
      </div>
    </div>
  );
}
