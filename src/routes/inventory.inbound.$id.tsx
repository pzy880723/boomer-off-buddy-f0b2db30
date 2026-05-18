import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { getInboundOrder } from "@/lib/inventory.functions";
import { CATEGORY_LABEL, formatPrice } from "@/lib/inventory.helpers";

export const Route = createFileRoute("/inventory/inbound/$id")({
  component: InboundDetailPage,
});

type LineRow = {
  id: string;
  qty: number;
  unit_price: number;
  subtotal: number;
  inv_skus: {
    id: string;
    name: string;
    category: string;
    price_tier: number;
    kind: "single" | "pack";
    epc: string;
    image_url: string | null;
  } | null;
};

function InboundDetailPage() {
  const { id } = Route.useParams();
  const getFn = useServerFn(getInboundOrder);
  const q = useQuery({
    queryKey: ["inv-inbound", id],
    queryFn: () => getFn({ data: { id } }),
  });

  if (q.isLoading) return <div className="p-6 text-muted-foreground">加载中…</div>;
  const order = q.data?.order;
  const lines = (q.data?.lines ?? []) as LineRow[];
  if (!order) return <div className="p-6 text-muted-foreground">记录不存在</div>;

  return (
    <div className="space-y-4">
      <Link to="/inventory/inbound" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary">
        <ArrowLeft className="h-3 w-3" /> 入库记录
      </Link>

      <PageHeader
        title={`入库单 ${order.id.slice(0, 8)}`}
        description={new Date(order.scanned_at).toLocaleString("zh-CN")}
        meta={
          <>
            <Badge variant="outline">{order.total_qty} 件</Badge>
            <Badge className="bg-primary/90 text-primary-foreground">¥{Number(order.total_value_cny).toFixed(2)}</Badge>
            {order.operator && <span>操作员：{order.operator}</span>}
          </>
        }
      />

      {order.notes && (
        <Card className="p-3 text-sm text-muted-foreground">
          备注：{order.notes}
        </Card>
      )}

      <DataTable
        rowKey={(r) => r.id}
        data={lines}
        columns={[
          {
            header: "商品",
            cell: (r) =>
              r.inv_skus ? (
                <Link
                  to="/inventory/skus/$id"
                  params={{ id: r.inv_skus.id }}
                  className="flex items-center gap-3 hover:text-primary"
                >
                  <div className="h-10 w-10 shrink-0 overflow-hidden rounded bg-muted">
                    {r.inv_skus.image_url && (
                      <img src={r.inv_skus.image_url} alt="" className="h-full w-full object-cover" />
                    )}
                  </div>
                  <div>
                    <div className="text-sm font-medium">{r.inv_skus.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {CATEGORY_LABEL[r.inv_skus.category] ?? r.inv_skus.category} · {formatPrice(r.inv_skus.price_tier)}
                      {r.inv_skus.kind === "pack" && " · 组包"}
                    </div>
                  </div>
                </Link>
              ) : (
                <span className="text-muted-foreground">(SKU 已删除)</span>
              ),
          },
          { header: "件数", cell: (r) => `+${r.qty}`, className: "tabular-nums text-success font-medium" },
          { header: "单价", cell: (r) => `¥${Number(r.unit_price).toFixed(2)}`, className: "tabular-nums" },
          {
            header: "小计",
            cell: (r) => <span className="font-semibold text-primary">¥{Number(r.subtotal).toFixed(2)}</span>,
            className: "tabular-nums",
          },
        ]}
      />
    </div>
  );
}
