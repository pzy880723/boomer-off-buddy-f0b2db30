import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Save, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import {
  BulkOrderForm,
  type BulkOrderFormValue,
  type BulkLineFormValue,
} from "@/components/domestic-bulk/bulk-order-form";
import {
  getDomesticBulkOrder,
  updateDomesticBulkOrder,
  removeDomesticBulkOrder,
} from "@/lib/domestic-bulk.functions";

export const Route = createFileRoute("/purchase/domestic-bulk/$id")({
  head: () => ({ meta: [{ title: "国内大宗订单详情" }] }),
  component: DomesticBulkDetailPage,
});

function DomesticBulkDetailPage() {
  const { id } = Route.useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const getFn = useServerFn(getDomesticBulkOrder);
  const updateFn = useServerFn(updateDomesticBulkOrder);
  const removeFn = useServerFn(removeDomesticBulkOrder);

  const q = useQuery({
    queryKey: ["domestic-bulk-order", id],
    queryFn: () => getFn({ data: { id } }),
  });

  const [order, setOrder] = useState<BulkOrderFormValue | null>(null);
  const [lines, setLines] = useState<BulkLineFormValue[]>([]);

  const updateMut = useMutation({
    mutationFn: () => {
      if (!order) throw new Error("表单未就绪");
      const { ...patch } = order;
      return updateFn({ data: { id, patch, lines } });
    },
    onSuccess: () => {
      toast.success("已保存");
      qc.invalidateQueries({ queryKey: ["domestic-bulk-order", id] });
      qc.invalidateQueries({ queryKey: ["domestic-bulk-orders"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const removeMut = useMutation({
    mutationFn: () => removeFn({ data: { id } }),
    onSuccess: () => {
      toast.success("已删除");
      qc.invalidateQueries({ queryKey: ["domestic-bulk-orders"] });
      nav({ to: "/purchase/domestic-bulk" });
    },
  });

  if (q.isLoading) return <div className="p-6 text-sm text-muted-foreground">加载中…</div>;
  if (!q.data?.order) return <div className="p-6 text-sm text-destructive">订单不存在</div>;

  const initialOrder = q.data.order as unknown as Partial<BulkOrderFormValue>;
  const initialLines = (q.data.lines ?? []).map((l) => ({
    position: l.position,
    item_title: l.item_title,
    qty: l.qty,
    unit_price_cny: l.unit_price_cny != null ? Number(l.unit_price_cny) : null,
    subtotal_cny: l.subtotal_cny != null ? Number(l.subtotal_cny) : null,
    notes: l.notes,
  })) as BulkLineFormValue[];

  return (
    <div className="space-y-4">
      <PageHeader
        title={initialOrder.supplier_name || "(未填供应商)"}
        description={`单号：${initialOrder.source_order_no ?? "-"}  ·  合同：${initialOrder.contract_no ?? "-"}`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => nav({ to: "/purchase/domestic-bulk" })}>
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> 返回
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive"
              onClick={() => {
                if (confirm("确定删除该订单？")) removeMut.mutate();
              }}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> 删除
            </Button>
            <Button
              size="sm"
              className="bg-gradient-brand hover:opacity-90"
              disabled={updateMut.isPending}
              onClick={() => updateMut.mutate()}
            >
              {updateMut.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-3.5 w-3.5" />
              )}
              保存
            </Button>
          </div>
        }
      />

      <BulkOrderForm
        initialOrder={initialOrder}
        initialLines={initialLines}
        onChange={(o, ls) => {
          setOrder(o);
          setLines(ls);
        }}
      />
    </div>
  );
}
