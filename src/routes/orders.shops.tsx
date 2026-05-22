import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { Link2, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable } from "@/components/data-table";
import { listShopOrders } from "@/lib/youzan.functions";



export const Route = createFileRoute("/orders/shops")({
  head: () => ({
    meta: [
      { title: "门店订单 · 订单管理" },
      { name: "description", content: "有赞各门店的销售订单" },
    ],
  }),
  component: ShopOrdersPage,
});

const cny = (n: number) =>
  new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 0 }).format(n);

function ShopOrdersPage() {
  const fetchFn = useServerFn(listShopOrders);
  const q = useQuery({ queryKey: ["shop-orders"], queryFn: () => fetchFn(), refetchInterval: 60_000 });

  const [shopFilter, setShopFilter] = useState<string>("all");

  const shops = q.data?.shops ?? [];
  const orders = q.data?.orders ?? [];
  const shopNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of shops) m.set(s.id, s.shop_name);
    return m;
  }, [shops]);

  const filtered = useMemo(() => {
    if (shopFilter === "all") return orders;
    return orders.filter((o) => o.shop_id === shopFilter);
  }, [orders, shopFilter]);

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      <PageHeader
        title="门店订单"
        description={`${orders.length} 条订单 · ${shops.length} 家门店`}
        actions={
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/youzan">
                <Link2 className="mr-1.5 h-3.5 w-3.5" />
                有赞对接
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => q.refetch()}
              disabled={q.isFetching}
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} />
              刷新
            </Button>
          </div>
        }
      />

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">门店筛选</span>
        <Select value={shopFilter} onValueChange={setShopFilter}>
          <SelectTrigger className="h-8 w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部门店</SelectItem>
            {shops.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.shop_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable
            rowKey={(r) => r.id}
            data={filtered}
            columns={[
              {
                header: "订单号",
                cell: (r) => <span className="font-mono text-xs">{r.tid}</span>,
              },
              {
                header: "门店",
                cell: (r) => (
                  <span className="text-xs">
                    {shopNameMap.get(r.shop_id) ?? `kdt_id ${r.kdt_id}`}
                  </span>
                ),
              },
              {
                header: "买家",
                cell: (r) => (
                  <span className="text-xs text-muted-foreground">{r.buyer_nick ?? "—"}</span>
                ),
              },
              { header: "件数", cell: (r) => <span className="tabular-nums">{r.num ?? 0}</span> },
              {
                header: "金额",
                cell: (r) => (
                  <span className="font-medium tabular-nums">
                    {cny(Number(r.payment ?? r.total_fee ?? 0))}
                  </span>
                ),
              },
              {
                header: "状态",
                cell: (r) => (
                  <span className="text-xs text-muted-foreground">{r.status ?? "—"}</span>
                ),
              },
              {
                header: "支付时间",
                cell: (r) => (
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {r.pay_time
                      ? new Date(r.pay_time).toLocaleString("zh-CN")
                      : "—"}
                  </span>
                ),
              },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
