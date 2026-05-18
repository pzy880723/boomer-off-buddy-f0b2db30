import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Package2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { listInboundOrders } from "@/lib/inventory.functions";

export const Route = createFileRoute("/inventory/inbound/")({
  head: () => ({
    meta: [{ title: "入库记录 · 库存" }],
  }),
  component: InboundListPage,
});

function InboundListPage() {
  const nav = useNavigate();
  const listFn = useServerFn(listInboundOrders);
  const q = useQuery({
    queryKey: ["inv-inbound"],
    queryFn: () => listFn({ data: { limit: 100 } }),
  });
  const rows = q.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="入库记录"
        description="每一次扫枪盘点入库都会生成一张记录"
        actions={
          <Button
            size="sm"
            className="bg-gradient-brand hover:opacity-90"
            onClick={() => nav({ to: "/inventory/inbound/new" })}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" /> 新建扫枪入库
          </Button>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={Package2}
          title="还没有入库记录"
          description="到「新建扫枪入库」开始第一单"
          action={
            <Button size="sm" onClick={() => nav({ to: "/inventory/inbound/new" })}>
              新建扫枪入库
            </Button>
          }
        />
      ) : (
        <DataTable
          rowKey={(r) => r.id}
          data={rows}
          columns={[
            {
              header: "时间",
              cell: (r) => (
                <Link
                  to="/inventory/inbound/$id"
                  params={{ id: r.id }}
                  className="text-xs tabular-nums hover:text-primary"
                >
                  {new Date(r.scanned_at).toLocaleString("zh-CN")}
                </Link>
              ),
            },
            { header: "件数", cell: (r) => `${r.total_qty} 件`, className: "tabular-nums" },
            {
              header: "金额",
              cell: (r) => <span className="font-semibold text-primary">¥{Number(r.total_value_cny).toFixed(2)}</span>,
              className: "tabular-nums",
            },
            { header: "操作员", cell: (r) => r.operator ?? "-" },
            { header: "来源", cell: (r) => r.source ?? "手动" },
            { header: "备注", cell: (r) => <span className="line-clamp-1 text-xs text-muted-foreground">{r.notes ?? "-"}</span> },
          ]}
        />
      )}
    </div>
  );
}
