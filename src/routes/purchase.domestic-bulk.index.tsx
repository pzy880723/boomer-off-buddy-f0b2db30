import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw, Plus, Search, Trash2, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import {
  listDomesticBulkOrders,
  countDomesticBulkOrders,
  setDomesticBulkOrderStatus,
  removeDomesticBulkOrder,
  BULK_STATUSES,
  BULK_STATUS_LABEL,
  type BulkStatus,
} from "@/lib/domestic-bulk.functions";

export const Route = createFileRoute("/purchase/domestic-bulk/")({
  head: () => ({
    meta: [
      { title: "国内大宗 · 采购物流" },
      { name: "description", content: "国内对公批量采购订单管理" },
    ],
  }),
  component: DomesticBulkListPage,
});

const statusTone: Record<BulkStatus, "success" | "warning" | "info" | "neutral" | "brand"> = {
  pending_pay: "warning",
  paid: "brand",
  shipped: "info",
  delivered: "success",
  completed: "neutral",
};

function DomesticBulkListPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const listFn = useServerFn(listDomesticBulkOrders);
  const countFn = useServerFn(countDomesticBulkOrders);
  const setStatusFn = useServerFn(setDomesticBulkOrderStatus);
  const removeFn = useServerFn(removeDomesticBulkOrder);

  const [status, setStatus] = useState<BulkStatus | "all">("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const listQ = useQuery({
    queryKey: ["domestic-bulk-orders", status, search],
    queryFn: () =>
      listFn({
        data: {
          status: status === "all" ? undefined : status,
          search: search || undefined,
          limit: 200,
        },
      }),
  });

  const countQ = useQuery({
    queryKey: ["domestic-bulk-orders-count"],
    queryFn: () => countFn(),
  });

  const statusMut = useMutation({
    mutationFn: (vars: { id: string; status: BulkStatus }) => setStatusFn({ data: vars }),
    onSuccess: () => {
      toast.success("状态已更新");
      qc.invalidateQueries({ queryKey: ["domestic-bulk-orders"] });
      qc.invalidateQueries({ queryKey: ["domestic-bulk-orders-count"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => removeFn({ data: { id } }),
    onSuccess: () => {
      toast.success("已删除");
      qc.invalidateQueries({ queryKey: ["domestic-bulk-orders"] });
      qc.invalidateQueries({ queryKey: ["domestic-bulk-orders-count"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const rows = listQ.data?.rows ?? [];
  const total = countQ.data?.total ?? 0;
  const totalCny = countQ.data?.totalCny ?? 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="国内大宗"
        description="国内对公 / 批量采购订单：供应商、明细、物流、合同票据一站记录"
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                listQ.refetch();
                countQ.refetch();
              }}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> 刷新
            </Button>
            <Button
              size="sm"
              className="bg-gradient-brand hover:opacity-90"
              onClick={() => nav({ to: "/purchase/domestic-bulk/new" })}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" /> 新建订单
            </Button>
          </div>
        }
      />

      {/* 统计卡 */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">订单总数</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {total}
              <span className="ml-0.5 text-sm text-muted-foreground"> 单</span>
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">累计金额</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">¥{Math.round(totalCny).toLocaleString("zh-CN")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">未完成</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {total - ((countQ.data?.byStatus.completed as number | undefined) ?? 0)}
              <span className="ml-0.5 text-sm text-muted-foreground"> 单</span>
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 筛选条 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜单号 / 供应商 / 物流 / 合同 / 发票"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setSearch(searchInput.trim());
            }}
            className="h-8 w-80 pl-7 text-xs"
          />
        </div>
        <Button size="sm" variant="outline" onClick={() => setSearch(searchInput.trim())}>
          搜索
        </Button>
        {search && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSearchInput("");
              setSearch("");
            }}
          >
            清除
          </Button>
        )}
        <Select value={status} onValueChange={(v) => setStatus(v as BulkStatus | "all")}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {BULK_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {BULK_STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        rowKey={(r) => r.id}
        data={rows}
        columns={[
          {
            header: "供应商 / 订单号",
            cell: (r) => (
              <Link
                to="/purchase/domestic-bulk/$id"
                params={{ id: r.id }}
                className="block max-w-md hover:text-primary"
              >
                <div className="line-clamp-1 font-medium">{r.supplier_name ?? "(未填供应商)"}</div>
                <div className="text-xs text-muted-foreground">
                  {r.source_order_no && (
                    <span className="font-mono text-[10px]">#{r.source_order_no}</span>
                  )}
                  {r.contract_no && (
                    <span className="ml-2 text-[10px]">合同 {r.contract_no}</span>
                  )}
                </div>
              </Link>
            ),
          },
          {
            header: "金额",
            cell: (r) => (
              <span className="font-semibold text-primary tabular-nums">
                {r.total_cny != null ? `¥${Number(r.total_cny).toLocaleString("zh-CN")}` : "-"}
              </span>
            ),
            className: "text-right",
          },
          {
            header: "采购时间",
            cell: (r) => (
              <span className="text-xs text-muted-foreground tabular-nums">
                {r.purchased_at ? new Date(r.purchased_at).toLocaleDateString("zh-CN") : "-"}
              </span>
            ),
          },
          {
            header: "物流",
            cell: (r) => (
              <div className="text-xs text-muted-foreground">
                {r.carrier ?? "-"}
                {r.tracking_no && <div className="font-mono text-[10px]">{r.tracking_no}</div>}
              </div>
            ),
          },
          {
            header: "状态",
            cell: (r) => (
              <Select
                value={r.status}
                onValueChange={(v) => statusMut.mutate({ id: r.id, status: v as BulkStatus })}
              >
                <SelectTrigger className="h-7 w-28 border-0 bg-transparent p-0 text-xs hover:bg-muted/50">
                  <StatusBadge tone={statusTone[r.status as BulkStatus]}>
                    {BULK_STATUS_LABEL[r.status as BulkStatus] ?? r.status}
                  </StatusBadge>
                </SelectTrigger>
                <SelectContent>
                  {BULK_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {BULK_STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ),
          },
          {
            header: "附件",
            cell: (r) => {
              const urls = (r.attachment_urls as string[] | null) ?? [];
              return urls.length > 0 ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Paperclip className="h-3 w-3" /> {urls.length}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">-</span>
              );
            },
          },
          {
            header: "操作",
            cell: (r) => (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                onClick={() => {
                  if (confirm("确定删除该订单？")) removeMut.mutate(r.id);
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            ),
            className: "text-right",
          },
        ]}
      />
    </div>
  );
}
