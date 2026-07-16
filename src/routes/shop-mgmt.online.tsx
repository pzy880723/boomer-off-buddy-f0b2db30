import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Archive,
  EyeOff,
  Globe,
  LockKeyhole,
  PackageOpen,
  RefreshCw,
  RotateCcw,
  Search,
  Store,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
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
import {
  listStorefrontListings,
  updateStorefrontListingLifecycle,
  type StorefrontAdminRow,
  type StorefrontLifecycle,
} from "@/lib/storefront-admin.functions";

export const Route = createFileRoute("/shop-mgmt/online")({
  head: () => ({
    meta: [
      { title: "网店商品 · BOOMER OFF" },
      { name: "description", content: "自研网店商品、门店库存与销售状态统一管理" },
    ],
  }),
  component: OnlineProductsPage,
});

const lifecycleTabs: Array<{ value: StorefrontLifecycle; label: string }> = [
  { value: "online", label: "已上架" },
  { value: "offline", label: "已下架" },
  { value: "sold", label: "已售罄" },
  { value: "recycle", label: "回收站" },
];

function cny(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
  }).format(value);
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN") : "—";
}

function statusLabel(status: StorefrontAdminRow["status"]) {
  return {
    draft: "已下架",
    published: "已上架",
    reserved: "订单锁定",
    sold: "已售罄",
    hidden: "已下架",
    archived: "回收站",
  }[status];
}

function statusTone(status: StorefrontAdminRow["status"]) {
  if (status === "published") return "success" as const;
  if (status === "reserved") return "warning" as const;
  if (status === "archived") return "danger" as const;
  return "neutral" as const;
}

function OnlineProductsPage() {
  const queryClient = useQueryClient();
  const listFn = useServerFn(listStorefrontListings);
  const updateFn = useServerFn(updateStorefrontListingLifecycle);
  const [lifecycle, setLifecycle] = useState<StorefrontLifecycle>("online");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("全部分类");

  const query = useQuery({
    queryKey: ["storefront-admin-listings", search],
    queryFn: () => listFn({ data: { search: search || undefined } }),
    placeholderData: keepPreviousData,
  });
  const rows = query.data?.rows ?? [];
  const categories = useMemo(
    () => ["全部分类", ...new Set(rows.map((row) => row.category_name))],
    [rows],
  );
  const filteredRows = useMemo(
    () =>
      rows.filter(
        (row) =>
          row.lifecycle === lifecycle &&
          (category === "全部分类" || row.category_name === category),
      ),
    [category, lifecycle, rows],
  );

  const mutation = useMutation({
    mutationFn: (input: { id: string; action: "publish" | "hide" | "archive" | "restore" }) =>
      updateFn({ data: input }),
    onSuccess: () => {
      toast.success("商品状态已更新");
      queryClient.invalidateQueries({ queryKey: ["storefront-admin-listings"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "状态更新失败"),
  });

  const runSearch = () => {
    setSearch(searchInput.trim());
    setCategory("全部分类");
  };

  return (
    <div>
      <PageHeader
        title="网店商品"
        description="管理自研网店的自定义商品。商品仍归属门店，门店库存是唯一可售库存。"
        meta={
          <span>
            当前 {filteredRows.length} 件 · 全部自定义商品 {rows.length} 件
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> 刷新
            </Button>
            <Button asChild size="sm">
              <Link to="/shop-mgmt/products">
                <Store className="mr-1.5 h-3.5 w-3.5" /> 从门店商品上架
              </Link>
            </Button>
          </div>
        }
      />

      <Card className="mb-4 rounded-md">
        <CardContent className="space-y-3 p-4">
          <Tabs
            value={lifecycle}
            onValueChange={(value) => setLifecycle(value as StorefrontLifecycle)}
          >
            <TabsList className="h-9">
              {lifecycleTabs.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value} className="gap-1.5 px-4">
                  {tab.label}
                  <span className="tabular-nums text-[11px] text-muted-foreground">
                    {query.data?.counts[tab.value] ?? 0}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-72 max-w-lg flex-1">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && runSearch()}
                placeholder="搜索商品名、条码、分类、品牌或门店"
                className="h-9 pl-8"
              />
            </div>
            <Button variant="outline" size="sm" onClick={runSearch}>
              搜索
            </Button>
          </div>

          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {categories.map((item) => (
              <Button
                key={item}
                size="sm"
                variant={category === item ? "default" : "outline"}
                className="h-7 shrink-0 px-3 text-xs"
                onClick={() => setCategory(item)}
              >
                {item}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="overflow-hidden rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>商品</TableHead>
              <TableHead>商品分类</TableHead>
              <TableHead>品牌</TableHead>
              <TableHead>所属门店</TableHead>
              <TableHead className="text-right">门店库存</TableHead>
              <TableHead className="text-right">网店售价</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>更新时间</TableHead>
              <TableHead className="w-44 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <div className="flex min-w-64 items-center gap-3">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
                      {row.cover_url ? (
                        <img src={row.cover_url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <PackageOpen className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{row.title}</div>
                      <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                        {row.sku_code ?? row.barcode ?? row.sku_id.slice(0, 8)}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="rounded-sm font-normal">
                    {row.category_name}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="text-sm">{row.brand_name}</div>
                  {row.brand_name_original && (
                    <div className="text-xs text-muted-foreground">{row.brand_name_original}</div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="text-sm">{row.location_name}</div>
                  <div className="text-xs text-muted-foreground">{row.location_kind ?? "门店"}</div>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {row.location_stock}
                </TableCell>
                <TableCell className="text-right font-mono font-medium tabular-nums">
                  {cny(row.price)}
                </TableCell>
                <TableCell>
                  <StatusBadge tone={statusTone(row.status)}>{statusLabel(row.status)}</StatusBadge>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDate(row.updated_at)}
                </TableCell>
                <TableCell className="text-right">
                  <ListingActions row={row} pending={mutation.isPending} onAction={mutation.mutate} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {!query.isLoading && filteredRows.length === 0 && (
          <EmptyState
            icon={Globe}
            title={`暂无${lifecycleTabs.find((tab) => tab.value === lifecycle)?.label}商品`}
            description="商品由门店自定义商品上架生成，网店不维护第二套库存。"
          />
        )}
      </div>
    </div>
  );
}

function ListingActions({
  row,
  pending,
  onAction,
}: {
  row: StorefrontAdminRow;
  pending: boolean;
  onAction: (input: {
    id: string;
    action: "publish" | "hide" | "archive" | "restore";
  }) => void;
}) {
  if (row.status === "reserved") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <LockKeyhole className="h-3.5 w-3.5" /> 待支付锁定
      </span>
    );
  }
  if (row.lifecycle === "online") {
    return (
      <Button size="sm" variant="outline" disabled={pending} onClick={() => onAction({ id: row.id, action: "hide" })}>
        <EyeOff className="mr-1 h-3.5 w-3.5" /> 下架
      </Button>
    );
  }
  if (row.lifecycle === "offline") {
    return (
      <div className="flex justify-end gap-1.5">
        <Button size="sm" disabled={pending} onClick={() => onAction({ id: row.id, action: "publish" })}>
          <Upload className="mr-1 h-3.5 w-3.5" /> 上架
        </Button>
        <Button size="icon" variant="ghost" disabled={pending} title="移入回收站" onClick={() => onAction({ id: row.id, action: "archive" })}>
          <Archive className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }
  if (row.lifecycle === "sold") {
    return (
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => onAction({ id: row.id, action: "archive" })}>
        <Archive className="mr-1 h-3.5 w-3.5" /> 归档
      </Button>
    );
  }
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => onAction({ id: row.id, action: "restore" })}>
      <RotateCcw className="mr-1 h-3.5 w-3.5" /> 恢复到已下架
    </Button>
  );
}
