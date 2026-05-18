import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw, Upload, Search, Trash2, Image as ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  listDomesticOrders,
  countDomesticOrders,
  setDomesticOrderStatus,
  removeDomesticOrder,
  PLATFORMS,
  STATUSES,
  PLATFORM_LABEL,
  STATUS_LABEL,
  type DomesticPlatform,
  type DomesticStatus,
} from "@/lib/domestic-orders.functions";

export const Route = createFileRoute("/purchase/domestic/")({
  head: () => ({
    meta: [
      { title: "国内渠道 · 采购物流" },
      { name: "description", content: "闲鱼/抖音/小红书/微信 等国内订单截图智能导入" },
    ],
  }),
  component: DomesticListPage,
});

const platformTone: Record<DomesticPlatform, string> = {
  xianyu: "bg-amber-500",
  douyin: "bg-neutral-900",
  xiaohongshu: "bg-rose-500",
  wechat: "bg-emerald-500",
  pinduoduo: "bg-red-600",
};

const statusTone: Record<DomesticStatus, "success" | "warning" | "info" | "neutral" | "brand"> = {
  pending_pay: "warning",
  paid: "brand",
  shipped: "info",
  delivered: "success",
  completed: "neutral",
};

function DomesticListPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const listFn = useServerFn(listDomesticOrders);
  const countFn = useServerFn(countDomesticOrders);
  const setStatusFn = useServerFn(setDomesticOrderStatus);
  const removeFn = useServerFn(removeDomesticOrder);

  const [platform, setPlatform] = useState<DomesticPlatform | "all">("all");
  const [status, setStatus] = useState<DomesticStatus | "all">("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const listQ = useQuery({
    queryKey: ["domestic-orders", platform, status, search],
    queryFn: () =>
      listFn({
        data: {
          platform: platform === "all" ? undefined : platform,
          status: status === "all" ? undefined : status,
          search: search || undefined,
          limit: 200,
        },
      }),
  });

  const countQ = useQuery({
    queryKey: ["domestic-orders-count"],
    queryFn: () => countFn(),
  });

  const statusMut = useMutation({
    mutationFn: (vars: { id: string; status: DomesticStatus }) =>
      setStatusFn({ data: vars }),
    onSuccess: () => {
      toast.success("状态已更新");
      qc.invalidateQueries({ queryKey: ["domestic-orders"] });
      qc.invalidateQueries({ queryKey: ["domestic-orders-count"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => removeFn({ data: { id } }),
    onSuccess: () => {
      toast.success("已删除");
      qc.invalidateQueries({ queryKey: ["domestic-orders"] });
      qc.invalidateQueries({ queryKey: ["domestic-orders-count"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const rows = listQ.data?.rows ?? [];
  const counts = countQ.data?.byPlatform ?? {};
  const total = countQ.data?.total ?? 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="国内渠道"
        description="闲鱼 / 抖音 / 小红书 / 微信 / 拼多多 订单截图智能识别 + 人工维护状态"
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
              onClick={() => nav({ to: "/purchase/domestic/import" })}
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" /> 导入截图
            </Button>
          </div>
        }
      />

      {/* 平台 tabs */}
      <Tabs value={platform} onValueChange={(v) => setPlatform(v as DomesticPlatform | "all")}>
        <TabsList>
          <TabsTrigger value="all">
            全部
            <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{total}</span>
          </TabsTrigger>
          {PLATFORMS.map((p) => (
            <TabsTrigger key={p} value={p} className="gap-1.5">
              <span className={`h-2 w-2 rounded-full ${platformTone[p]}`} />
              {PLATFORM_LABEL[p]}
              <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] tabular-nums">
                {counts[p] ?? 0}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* 筛选条 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜单号 / 商品 / 卖家 / 物流单号"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setSearch(searchInput.trim());
            }}
            className="h-8 w-72 pl-7 text-xs"
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
        <Select value={status} onValueChange={(v) => setStatus(v as DomesticStatus | "all")}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABEL[s]}
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
            header: "平台",
            cell: (r) => (
              <span
                className={`inline-flex h-5 items-center rounded px-1.5 text-[10px] font-medium text-white ${platformTone[r.platform as DomesticPlatform] ?? "bg-muted-foreground"}`}
              >
                {PLATFORM_LABEL[r.platform as DomesticPlatform] ?? r.platform}
              </span>
            ),
          },
          {
            header: "商品 / 卖家",
            cell: (r) => (
              <Link
                to="/purchase/domestic/$id"
                params={{ id: r.id }}
                className="block max-w-md hover:text-primary"
              >
                <div className="line-clamp-1 font-medium">{r.item_title ?? "(无标题)"}</div>
                <div className="text-xs text-muted-foreground">
                  {r.seller_name ?? "-"}
                  {r.source_order_no && (
                    <span className="ml-2 font-mono text-[10px]">#{r.source_order_no}</span>
                  )}
                </div>
              </Link>
            ),
          },
          {
            header: "实付",
            cell: (r) => (
              <span className="font-semibold text-primary tabular-nums">
                {r.total_cny != null ? `¥${Number(r.total_cny).toFixed(2)}` : "-"}
              </span>
            ),
            className: "text-right",
          },
          {
            header: "下单",
            cell: (r) => (
              <span className="text-xs text-muted-foreground tabular-nums">
                {r.purchased_at ? new Date(r.purchased_at).toLocaleDateString("zh-CN") : "-"}
              </span>
            ),
          },
          {
            header: "状态",
            cell: (r) => (
              <Select
                value={r.status}
                onValueChange={(v) => statusMut.mutate({ id: r.id, status: v as DomesticStatus })}
              >
                <SelectTrigger className="h-7 w-28 border-0 bg-transparent p-0 text-xs hover:bg-muted/50">
                  <StatusBadge tone={statusTone[r.status as DomesticStatus]}>
                    {STATUS_LABEL[r.status as DomesticStatus] ?? r.status}
                  </StatusBadge>
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ),
          },
          {
            header: "截图",
            cell: (r) => {
              const urls = (r.screenshot_urls as string[] | null) ?? [];
              return urls.length > 0 ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <ImageIcon className="h-3 w-3" /> {urls.length}
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
