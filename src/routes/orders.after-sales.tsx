import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ClipboardCheck, Search } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  listCommerceAfterSales,
  transitionCommerceAfterSale,
  type CommerceAfterSaleAdminRow,
} from "@/lib/commerce-operations.functions";

export const Route = createFileRoute("/orders/after-sales")({
  head: () => ({ meta: [{ title: "售后订单 · BOOMER OFF" }] }),
  component: AfterSalesPage,
});

type AfterSaleView = "active" | "refund_pending" | "done" | "all";
type NextAfterSaleStatus =
  | "store_reviewing"
  | "approved"
  | "rejected"
  | "customer_shipping"
  | "store_received"
  | "inspecting"
  | "refund_pending"
  | "closed";
const statusLabel: Record<string, string> = {
  requested: "待门店接单",
  store_reviewing: "门店审核中",
  approved: "已同意",
  rejected: "已拒绝",
  customer_shipping: "顾客寄回中",
  store_received: "门店已收货",
  inspecting: "门店验货中",
  refund_pending: "待退款",
  refunded: "已退款",
  closed: "已关闭",
  cancelled: "已取消",
};

function afterSaleView(row: CommerceAfterSaleAdminRow): AfterSaleView {
  if (row.status === "refund_pending") return "refund_pending";
  if (["rejected", "refunded", "closed", "cancelled"].includes(row.status)) return "done";
  return "active";
}

function nextAction(status: string): { label: string; next: NextAfterSaleStatus } | null {
  const actions: Partial<Record<string, { label: string; next: NextAfterSaleStatus }>> = {
    requested: { label: "门店接单", next: "store_reviewing" },
    store_reviewing: { label: "同意申请", next: "approved" },
    approved: { label: "确认收货", next: "store_received" },
    customer_shipping: { label: "确认收货", next: "store_received" },
    store_received: { label: "开始验货", next: "inspecting" },
    inspecting: { label: "提交退款", next: "refund_pending" },
  };
  return actions[status] ?? null;
}

function AfterSalesPage() {
  const queryClient = useQueryClient();
  const listFn = useServerFn(listCommerceAfterSales);
  const transitionFn = useServerFn(transitionCommerceAfterSale);
  const [view, setView] = useState<AfterSaleView>("active");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: ["commerce-after-sales", search],
    queryFn: () => listFn({ data: { search: search || undefined } }),
  });
  const rows = query.data?.rows ?? [];
  const filtered = useMemo(
    () => rows.filter((row) => view === "all" || afterSaleView(row) === view),
    [rows, view],
  );
  const mutation = useMutation({
    mutationFn: (input: { id: string; next_status: NextAfterSaleStatus }) =>
      transitionFn({ data: input }),
    onSuccess: () => {
      toast.success("售后状态已更新");
      queryClient.invalidateQueries({ queryKey: ["commerce-after-sales"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "售后更新失败"),
  });

  return (
    <div>
      <PageHeader
        title="售后订单"
        description="售后按商品来源门店分配。门店负责审核、收货和验货；退款由支付系统回调完成。"
        meta={<span>当前 {filtered.length} 单 · 全部 {rows.length} 单</span>}
      />
      <Card className="mb-4 rounded-md">
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <Tabs value={view} onValueChange={(value) => setView(value as AfterSaleView)}>
            <TabsList className="h-9">
              <TabsTrigger value="active">处理中</TabsTrigger>
              <TabsTrigger value="refund_pending">待退款</TabsTrigger>
              <TabsTrigger value="done">已结束</TabsTrigger>
              <TabsTrigger value="all">全部</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative min-w-72 max-w-lg flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} onKeyDown={(event) => event.key === "Enter" && setSearch(searchInput.trim())} placeholder="搜索售后单、订单、客户、商品或门店" className="h-9 pl-8" />
          </div>
          <Button size="sm" variant="outline" onClick={() => setSearch(searchInput.trim())}>搜索</Button>
        </CardContent>
      </Card>

      <div className="overflow-hidden rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>售后单</TableHead><TableHead>商品</TableHead><TableHead>客户订单</TableHead>
              <TableHead>负责门店</TableHead><TableHead>原因</TableHead><TableHead className="text-right">申请金额</TableHead>
              <TableHead>状态</TableHead><TableHead className="w-32 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((row) => {
              const action = nextAction(row.status);
              return (
                <TableRow key={row.id}>
                  <TableCell><div className="font-mono text-xs">{row.after_sale_no}</div><div className="mt-1 text-xs text-muted-foreground">{new Date(row.requested_at).toLocaleString("zh-CN")}</div></TableCell>
                  <TableCell><div className="max-w-64 truncate text-sm">{row.order_item?.title_snapshot ?? "未知商品"}</div></TableCell>
                  <TableCell><div className="font-mono text-xs">{row.order?.order_no ?? "—"}</div><div className="mt-1 text-xs text-muted-foreground">{row.order?.recipient_name ?? "—"} · {row.order?.recipient_phone ?? "—"}</div></TableCell>
                  <TableCell className="text-sm">{row.location?.name ?? "未知门店"}</TableCell>
                  <TableCell><div className="text-sm">{row.reason_code}</div>{row.reason_text && <div className="max-w-48 truncate text-xs text-muted-foreground">{row.reason_text}</div>}</TableCell>
                  <TableCell className="text-right font-mono font-medium">¥{Number(row.requested_amount).toFixed(2)}</TableCell>
                  <TableCell><StatusBadge>{statusLabel[row.status] ?? row.status}</StatusBadge></TableCell>
                  <TableCell className="text-right">
                    {action ? (
                      <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate({ id: row.id, next_status: action.next })}>{action.label}</Button>
                    ) : row.status === "refund_pending" ? (
                      <span className="text-xs text-muted-foreground">等待支付退款</span>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {!query.isLoading && filtered.length === 0 && <EmptyState icon={ClipboardCheck} title="暂无售后订单" description="顾客发起售后后，会按商品来源门店进入这里。" />}
      </div>
    </div>
  );
}
