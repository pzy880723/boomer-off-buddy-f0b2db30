import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRight, AlertCircle, CheckCircle2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { listStockTransfers } from "@/lib/stock-transfer.functions";

export const Route = createFileRoute("/inventory/transfers")({
  head: () => ({
    meta: [
      { title: "调拨单 · 仓库管理" },
      { name: "description", content: "仓库与门店之间的库存调拨流水" },
    ],
  }),
  component: TransfersPage,
});

type Transfer = {
  id: string;
  code: string;
  kind: string;
  status: string;
  qty: number;
  from_shop_id: string | null;
  to_shop_id: string | null;
  from_sku_id: string | null;
  to_sku_id: string | null;
  from_youzan_item_id: number | null;
  to_youzan_item_id: number | null;
  reason: string | null;
  operator: string | null;
  notes: string | null;
  youzan_sync_status: string;
  youzan_error_msg: string | null;
  created_at: string;
};

const KIND_LABEL: Record<string, string> = {
  wh_to_shop: "仓库 → 门店",
  shop_to_shop: "门店 → 门店",
  shop_to_wh: "门店 → 仓库",
  consume: "销售 / 损耗",
};

function TransfersPage() {
  const fn = useServerFn(listStockTransfers);
  const { data, isLoading } = useQuery({
    queryKey: ["stock-transfers"],
    queryFn: () => fn({ data: { limit: 100 } }),
  });
  const rows = (data?.transfers ?? []) as Transfer[];
  const ok = rows.filter((r) => r.status === "posted").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const totalQty = rows.filter((r) => r.status === "posted").reduce((s, r) => s + r.qty, 0);

  return (
    <div>
      <PageHeader
        title="调拨单"
        description="所有调拨流水（仓库 ↔ 门店、门店 ↔ 门店、销售损耗）"
        meta={
          <>
            <span>共 {rows.length} 单</span>
            <span className="text-border">·</span>
            <span className="text-success inline-flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" />
              成功 {ok}
            </span>
            {failed > 0 && (
              <>
                <span className="text-border">·</span>
                <span className="text-destructive inline-flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  失败 {failed}
                </span>
              </>
            )}
            <span className="text-border">·</span>
            <span>合计 {totalQty} 件</span>
          </>
        }
      />

      {isLoading && <p className="mb-2 text-xs text-muted-foreground">加载中…</p>}

      <DataTable
        rowKey={(r: Transfer) => r.id}
        data={rows}
        columns={[
          {
            header: "单号",
            cell: (r) => <span className="font-mono text-xs">{r.code}</span>,
          },
          {
            header: "类型",
            cell: (r) => <Badge variant="outline">{KIND_LABEL[r.kind] ?? r.kind}</Badge>,
          },
          {
            header: "路径",
            cell: (r) => (
              <div className="flex items-center gap-1.5 text-xs">
                <span>
                  {r.from_sku_id ? "仓库 SKU" : r.from_shop_id ? `店#${r.from_youzan_item_id ?? "-"}` : "-"}
                </span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span>
                  {r.to_sku_id ? "仓库 SKU" : r.to_shop_id ? `店#${r.to_youzan_item_id ?? "-"}` : r.kind === "consume" ? "出库" : "-"}
                </span>
              </div>
            ),
          },
          {
            header: "数量",
            cell: (r) => <span className="tabular-nums">{r.qty}</span>,
            className: "text-right",
          },
          {
            header: "原因/备注",
            cell: (r) => (
              <span className="text-xs text-muted-foreground truncate max-w-[180px] inline-block">
                {r.reason || r.notes || "-"}
              </span>
            ),
          },
          {
            header: "操作员",
            cell: (r) => <span className="text-xs">{r.operator || "-"}</span>,
          },
          {
            header: "有赞同步",
            cell: (r) =>
              r.youzan_sync_status === "ok" ? (
                <Badge className="text-[10px] bg-success text-success-foreground hover:bg-success">同步成功</Badge>
              ) : r.youzan_sync_status === "not_required" ? (
                <Badge variant="secondary" className="text-[10px]">无需同步</Badge>
              ) : r.youzan_sync_status === "partial" ? (
                <Badge variant="destructive" className="text-[10px]">部分失败</Badge>
              ) : (
                <Badge variant="destructive" className="text-[10px]" title={r.youzan_error_msg ?? ""}>
                  失败
                </Badge>
              ),
          },
          {
            header: "时间",
            cell: (r) => (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {new Date(r.created_at).toLocaleString("zh-CN", { hour12: false })}
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}
