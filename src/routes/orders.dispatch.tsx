import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { ArrowLeftRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";

const listDispatchOrders = createServerFn({ method: "GET" }).handler(
  async () => {
    const { data, error } = await supabase
      .from("stock_transfers")
      .select("id, code, kind, qty, status, reason, posted_at, created_at, from_shop_id, to_shop_id")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return { rows: data ?? [] };
  },
);

export const Route = createFileRoute("/orders/dispatch")({
  head: () => ({
    meta: [
      { title: "铺货订单 · 订单管理" },
      { name: "description", content: "总仓 → 门店铺货 / 调拨" },
    ],
  }),
  component: DispatchPage,
});

function DispatchPage() {
  const fetchFn = useServerFn(listDispatchOrders);
  const q = useQuery({ queryKey: ["dispatch-orders"], queryFn: () => fetchFn() });
  const rows = q.data?.rows ?? [];

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      <PageHeader
        title="铺货订单"
        description="总仓 → 门店 调拨 / 铺货单（数据来自调拨单模块）"
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/inventory/transfers">
              <ArrowLeftRight className="mr-1.5 h-3.5 w-3.5" />
              管理调拨单
            </Link>
          </Button>
        }
      />
      <Card>
        <CardContent className="p-0">
          <DataTable
            rowKey={(r) => r.id}
            data={rows}
            empty={q.isLoading ? "加载中…" : "尚无铺货记录"}
            columns={[
              {
                header: "单号",
                cell: (r) => <span className="font-mono text-xs">{r.code}</span>,
              },
              {
                header: "类型",
                cell: (r) => <span className="text-xs text-muted-foreground">{r.kind}</span>,
              },
              { header: "数量", cell: (r) => <span className="tabular-nums">{r.qty}</span> },
              {
                header: "原因",
                cell: (r) => (
                  <span className="text-xs text-muted-foreground line-clamp-1">
                    {r.reason ?? "—"}
                  </span>
                ),
              },
              { header: "状态", cell: (r) => <StatusBadge status={r.status} /> },
              {
                header: "时间",
                cell: (r) => (
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {new Date(r.posted_at ?? r.created_at).toLocaleString("zh-CN")}
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
