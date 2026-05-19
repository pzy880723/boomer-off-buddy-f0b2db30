import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Save, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import {
  BulkOrderForm,
  type BulkOrderFormValue,
  type BulkLineFormValue,
} from "@/components/domestic-bulk/bulk-order-form";
import { createDomesticBulkOrder } from "@/lib/domestic-bulk.functions";

export const Route = createFileRoute("/purchase/domestic-bulk/new")({
  head: () => ({ meta: [{ title: "新建国内大宗订单" }] }),
  component: NewDomesticBulkPage,
});

function NewDomesticBulkPage() {
  const nav = useNavigate();
  const createFn = useServerFn(createDomesticBulkOrder);
  const [order, setOrder] = useState<BulkOrderFormValue | null>(null);
  const [lines, setLines] = useState<BulkLineFormValue[]>([]);

  const createMut = useMutation({
    mutationFn: () => {
      if (!order) throw new Error("表单未就绪");
      return createFn({ data: { order, lines } });
    },
    onSuccess: (res) => {
      toast.success("已创建");
      nav({ to: "/purchase/domestic-bulk/$id", params: { id: res.id } });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="新建国内大宗订单"
        description="录入供应商、商品明细、物流和合同信息"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => nav({ to: "/purchase/domestic-bulk" })}>
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> 返回
            </Button>
            <Button
              size="sm"
              className="bg-gradient-brand hover:opacity-90"
              disabled={createMut.isPending}
              onClick={() => createMut.mutate()}
            >
              {createMut.isPending ? (
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
        onChange={(o, ls) => {
          setOrder(o);
          setLines(ls);
        }}
      />
    </div>
  );
}
