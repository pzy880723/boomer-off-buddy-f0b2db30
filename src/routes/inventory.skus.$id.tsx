import { useState, useRef } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Printer, Package2, Tags, Pencil, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DataTable } from "@/components/data-table";
import { SkuEditDialog } from "@/components/inventory/sku-edit-dialog";
import { PrintLabels, PRINT_STYLE } from "@/components/inventory/sku-detail-shared";
import { SkuYouzanCard } from "@/components/youzan/sku-youzan-card";
import { getSku, createLabelBatch, deleteSku } from "@/lib/inventory.functions";
import {
  CATEGORY_LABEL,
  SKU_KIND_LABEL,
  formatPrice,
  type SkuKind,
  type SkuRow,
} from "@/lib/inventory.helpers";

export const Route = createFileRoute("/inventory/skus/$id")({
  component: SkuDetailPage,
});

function SkuDetailPage() {
  const { id } = Route.useParams();
  const nav = useNavigate();
  const getFn = useServerFn(getSku);
  const printFn = useServerFn(createLabelBatch);
  const delFn = useServerFn(deleteSku);
  const [qty, setQty] = useState("10");
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  const q = useQuery({
    queryKey: ["inv-sku", id],
    queryFn: () => getFn({ data: { id } }),
  });

  const mut = useMutation({
    mutationFn: () => printFn({ data: { sku_id: id, qty: Number(qty) } }),
    onSuccess: () => {
      toast.success(`已记录打印 ${qty} 张，准备调起打印机…`);
      q.refetch();
      setTimeout(() => window.print(), 200);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const delMut = useMutation({
    mutationFn: () => delFn({ data: { id } }),
    onSuccess: () => {
      toast.success("已删除");
      nav({ to: "/inventory/skus" });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const sku = q.data?.sku as SkuRow | undefined;
  const labels = q.data?.labels ?? [];
  const lines = q.data?.lines ?? [];
  const bundleChildren = q.data?.bundle_children ?? [];

  if (q.isLoading) return <div className="p-6 text-muted-foreground">加载中…</div>;
  if (!sku) return <div className="p-6 text-muted-foreground">SKU 不存在</div>;

  const printCount = Math.max(1, Math.min(1000, Number(qty) || 0));
  const skuCode = sku.sku_code;
  const isBundle = sku.kind === "bundle";

  return (
    <div className="space-y-4">
      {/* 顶栏 */}
      <div className="flex items-center justify-between">
        <Link to="/inventory/skus" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary">
          <ArrowLeft className="h-3 w-3" /> 返回 SKU 列表
        </Link>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil className="mr-1.5 h-3.5 w-3.5" /> 编辑
          </Button>
          <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmDel(true)}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" /> 删除
          </Button>
        </div>
      </div>

      {/* 主信息 */}
      <Card className="p-5">
        <div className="flex flex-col gap-5 sm:flex-row">
          <div className="h-40 w-40 flex-shrink-0 overflow-hidden rounded-lg border bg-muted sm:h-48 sm:w-48">
            {sku.image_url ? (
              <img src={sku.image_url} alt={sku.name} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                <Tags className="h-10 w-10" />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {CATEGORY_LABEL[sku.category] ?? sku.category} · {SKU_KIND_LABEL[sku.kind as SkuKind] ?? sku.kind}
                {isBundle ? ` · 含 ${bundleChildren.length} 种子项` : ""}
              </p>
              <h1 className="mt-1 text-xl font-bold leading-tight sm:text-2xl">{sku.name}</h1>
            </div>

            <div className="rounded-lg bg-muted/50 p-3">
              <div className="flex items-baseline gap-3">
                <span className="text-2xl font-bold text-primary">{formatPrice(sku.price_tier)}</span>
                <Badge variant="outline" className="tabular-nums">库存 {sku.stock_qty} 件</Badge>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
              <Attr label="EPC" value={<span className="font-mono">{sku.epc}</span>} />
              {skuCode && <Attr label="商品编码" value={<span className="font-mono">{skuCode}</span>} />}
              {sku.weight_g != null && <Attr label="单件重量" value={`${sku.weight_g} g`} />}
              <Attr label="状态" value={sku.status === "active" ? "在售" : "已归档"} />
            </div>
          </div>
        </div>
      </Card>

      {/* 有赞同步卡 */}
      <SkuYouzanCard skuId={sku.id} skuName={sku.name} />

      {/* 分块 Tabs */}

      <Tabs defaultValue={isBundle ? "children" : "print"}>
        <TabsList>
          {isBundle && <TabsTrigger value="children">子项 {bundleChildren.length}</TabsTrigger>}
          <TabsTrigger value="print">RFID 打印</TabsTrigger>
          <TabsTrigger value="labels">打印记录</TabsTrigger>
          <TabsTrigger value="inbound">入库历史</TabsTrigger>
          {sku.notes && <TabsTrigger value="notes">备注</TabsTrigger>}
        </TabsList>

        {isBundle && (
          <TabsContent value="children" className="mt-4">
            <Card className="p-4">
              <ul className="divide-y">
                {bundleChildren.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 py-2">
                    <div className="h-10 w-10 shrink-0 overflow-hidden rounded bg-muted">
                      {c.image_url ? <img src={c.image_url} alt={c.name} className="h-full w-full object-cover" /> : null}
                    </div>
                    <Link to="/inventory/skus/$id" params={{ id: c.id }} className="min-w-0 flex-1 hover:underline">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">{formatPrice(c.price_tier)} · {c.epc}</p>
                    </Link>
                    <span className="text-sm font-bold tabular-nums">×{c.qty}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="print" className="mt-4">
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">RFID 标签打印</h3>
              <span className="text-xs text-muted-foreground">同 SKU 共用一个 EPC</span>
            </div>
            <div className="flex items-end gap-3">
              <div className="space-y-1.5">
                <Label>打印张数</Label>
                <Input
                  type="number"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  className="w-32"
                />
              </div>
              <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
                <Printer className="mr-1.5 h-3.5 w-3.5" />
                {mut.isPending ? "提交中…" : "打印并记录"}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              打印完成后请贴到商品上，然后到「扫枪入库」页扫码完成盘点入库。
            </p>
          </Card>
        </TabsContent>

        <TabsContent value="labels" className="mt-4">
          <Card className="p-4">
            <DataTable
              rowKey={(r: { id: string }) => r.id}
              data={labels as { id: string; qty: number; printed_at: string; status: string; operator: string | null }[]}
              columns={[
                {
                  header: "时间",
                  cell: (r) => (
                    <span className="text-xs tabular-nums">
                      {new Date(r.printed_at).toLocaleString("zh-CN")}
                    </span>
                  ),
                },
                { header: "数量", cell: (r) => `${r.qty} 张`, className: "tabular-nums" },
                { header: "状态", cell: (r) => <Badge variant="outline">{r.status}</Badge> },
                { header: "操作员", cell: (r) => r.operator ?? "-" },
              ]}
            />
          </Card>
        </TabsContent>

        <TabsContent value="inbound" className="mt-4">
          <Card className="p-4">
            <div className="mb-3 flex items-center gap-2">
              <Package2 className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">入库历史</h3>
            </div>
            <DataTable
              rowKey={(r: { id: string }) => r.id}
              data={lines as { id: string; qty: number; unit_price: number; subtotal: number; created_at: string }[]}
              columns={[
                {
                  header: "时间",
                  cell: (r) => (
                    <span className="text-xs tabular-nums">
                      {new Date(r.created_at).toLocaleString("zh-CN")}
                    </span>
                  ),
                },
                { header: "件数", cell: (r) => `+${r.qty}`, className: "tabular-nums text-success" },
                { header: "单价", cell: (r) => `¥${Number(r.unit_price).toFixed(2)}`, className: "tabular-nums" },
                { header: "小计", cell: (r) => `¥${Number(r.subtotal).toFixed(2)}`, className: "tabular-nums" },
              ]}
            />
          </Card>
        </TabsContent>

        {sku.notes && (
          <TabsContent value="notes" className="mt-4">
            <Card className="p-4">
              <p className="whitespace-pre-wrap text-xs leading-relaxed">{sku.notes}</p>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {/* 打印预览 */}
      <div ref={printRef} className="print-area hidden">
        <PrintLabels
          epc={sku.epc}
          name={sku.name}
          price={Number(sku.price_tier)}
          category={CATEGORY_LABEL[sku.category] ?? sku.category}
          count={printCount}
        />
      </div>

      <style>{PRINT_STYLE}</style>

      <SkuEditDialog
        sku={sku}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={() => q.refetch()}
      />

      <AlertDialog open={confirmDel} onOpenChange={setConfirmDel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{sku.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              若该 SKU 有库存或入库记录，删除会失败。请先归档或清空库存。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={delMut.isPending}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={delMut.isPending}
              onClick={(e) => {
                e.preventDefault();
                delMut.mutate();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {delMut.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Attr({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all">{value}</span>
    </div>
  );
}
