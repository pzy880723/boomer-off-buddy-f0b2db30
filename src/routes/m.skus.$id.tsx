import { useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Pencil,
  Printer,
  Trash2,
  Loader2,
  Tags,
  Boxes,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import { MobileShell } from "@/components/mobile/mobile-shell";
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
import { SkuEditDialog } from "@/components/inventory/sku-edit-dialog";
import { SkuImageGallery } from "@/components/inventory/sku-image-gallery";
import { PrintLabels, PRINT_STYLE } from "@/components/inventory/sku-detail-shared";
import { SKU_GRADE_OPTIONS } from "@/components/inventory/sku-meta-fields";
import { getSku, createLabelBatch, deleteSku } from "@/lib/inventory.functions";
import {
  CATEGORY_LABEL,
  SKU_KIND_LABEL,
  formatPrice,
  type SkuKind,
  type SkuRow,
} from "@/lib/inventory.helpers";

export const Route = createFileRoute("/m/skus/$id")({
  head: () => ({ meta: [{ title: "商品详情 · 移动" }] }),
  component: MSkuDetail,
});

function MSkuDetail() {
  const { id } = Route.useParams();
  const nav = useNavigate();
  const getFn = useServerFn(getSku);
  const printFn = useServerFn(createLabelBatch);
  const delFn = useServerFn(deleteSku);
  const printRef = useRef<HTMLDivElement>(null);
  const [qty, setQty] = useState("10");
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const q = useQuery({
    queryKey: ["m-inv-sku", id],
    queryFn: () => getFn({ data: { id } }),
  });

  const printMut = useMutation({
    mutationFn: () => printFn({ data: { sku_id: id, qty: Number(qty) } }),
    onSuccess: () => {
      toast.success(`已记录打印 ${qty} 张`);
      q.refetch();
      setTimeout(() => window.print(), 200);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const delMut = useMutation({
    mutationFn: () => delFn({ data: { id } }),
    onSuccess: () => {
      toast.success("已删除");
      nav({ to: "/m/skus" });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const sku = q.data?.sku as SkuRow | undefined;
  const signedImages = (q.data?.signed_images ?? []) as string[];
  const labels = (q.data?.labels ?? []) as {
    id: string;
    qty: number;
    printed_at: string;
    status: string;
    operator: string | null;
  }[];
  const lines = (q.data?.lines ?? []) as {
    id: string;
    qty: number;
    unit_price: number;
    subtotal: number;
    created_at: string;
  }[];
  const bundleChildren = (q.data?.bundle_children ?? []) as {
    id: string;
    name: string;
    image_url: string | null;
    price_tier: number;
    epc: string;
    qty: number;
  }[];

  const rightSlot = sku ? (
    <>
      <button
        type="button"
        onClick={() => setEditOpen(true)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground active:bg-muted"
        aria-label="编辑"
      >
        <Pencil className="h-4.5 w-4.5" />
      </button>
      <button
        type="button"
        onClick={() => setConfirmDel(true)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-destructive active:bg-muted"
        aria-label="删除"
      >
        <Trash2 className="h-4.5 w-4.5" />
      </button>
    </>
  ) : null;

  if (q.isLoading) {
    return (
      <MobileShell title="商品详情" back="/m/skus">
        <div className="p-6 text-sm text-muted-foreground">加载中…</div>
      </MobileShell>
    );
  }
  if (!sku) {
    return (
      <MobileShell title="商品详情" back="/m/skus">
        <div className="p-6 text-sm text-muted-foreground">SKU 不存在</div>
      </MobileShell>
    );
  }

  const printCount = Math.max(1, Math.min(1000, Number(qty) || 0));
  const isBundle = sku.kind === "bundle";
  const gradeOpt = SKU_GRADE_OPTIONS.find(
    (g) => g.value === (sku as { grade?: string | null }).grade,
  );

  const copy = (text: string, label: string) => {
    try {
      navigator.clipboard?.writeText(text);
      toast.success(`${label}已复制`);
    } catch {
      // ignore
    }
  };

  return (
    <MobileShell title="商品详情" back="/m/skus" rightSlot={rightSlot}>
      <div className="space-y-3 p-3">
        {/* 主信息 */}
        <Card className="overflow-hidden p-0">
          <div className="p-3 pb-0">
            <SkuImageGallery
              images={signedImages}
              fallbackUrl={sku.image_url}
              alt={sku.name}
            />
          </div>
          <div className="space-y-2 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">
                {CATEGORY_LABEL[sku.category] ?? sku.category}
              </Badge>
              <Badge variant="outline">
                {isBundle ? (
                  <>
                    <Boxes className="mr-0.5 h-3 w-3" />
                    组包 · {bundleChildren.length} 种
                  </>
                ) : (
                  SKU_KIND_LABEL[sku.kind as SkuKind] ?? sku.kind
                )}
              </Badge>
              {gradeOpt && <Badge>{gradeOpt.label}</Badge>}
              <Badge variant={sku.status === "active" ? "default" : "outline"}>
                {sku.status === "active" ? "在售" : "已归档"}
              </Badge>
            </div>
            <h1 className="text-lg font-bold leading-snug">{sku.name}</h1>
            <div className="flex items-baseline gap-3 pt-1">
              <span className="text-2xl font-bold text-primary">
                {formatPrice(sku.price_tier)}
              </span>
              <span className="text-sm tabular-nums text-muted-foreground">
                库存 {sku.stock_qty} 件
              </span>
            </div>
          </div>
        </Card>

        {/* 属性 */}
        <Card className="divide-y p-0 text-xs">
          <AttrRow
            label="EPC"
            value={sku.epc}
            onCopy={() => copy(sku.epc, "EPC")}
            mono
          />
          {sku.sku_code && (
            <AttrRow
              label="商品编码"
              value={sku.sku_code}
              onCopy={() => copy(sku.sku_code!, "编码")}
              mono
            />
          )}
          {sku.weight_g != null && (
            <AttrRow label="单件重量" value={`${sku.weight_g} g`} />
          )}
          {gradeOpt && (
            <AttrRow label="评级" value={`${gradeOpt.label} · ${gradeOpt.desc}`} />
          )}
        </Card>

        {/* Tabs */}
        <Tabs defaultValue={isBundle ? "children" : "print"}>
          <TabsList className="w-full overflow-x-auto">
            {isBundle && (
              <TabsTrigger value="children">子项 {bundleChildren.length}</TabsTrigger>
            )}
            <TabsTrigger value="print">打印</TabsTrigger>
            <TabsTrigger value="labels">打印记录</TabsTrigger>
            <TabsTrigger value="inbound">入库</TabsTrigger>
            {sku.notes && <TabsTrigger value="notes">备注</TabsTrigger>}
          </TabsList>

          {isBundle && (
            <TabsContent value="children" className="mt-3">
              <Card className="divide-y p-0">
                {bundleChildren.map((c) => (
                  <Link
                    key={c.id}
                    to="/m/skus/$id"
                    params={{ id: c.id }}
                    className="flex items-center gap-3 p-3 active:bg-muted"
                  >
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-muted">
                      {c.image_url ? (
                        <img
                          src={c.image_url}
                          alt={c.name}
                          className="h-full w-full object-cover"
                        />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {formatPrice(c.price_tier)} · {c.epc}
                      </p>
                    </div>
                    <span className="text-sm font-bold tabular-nums">×{c.qty}</span>
                  </Link>
                ))}
              </Card>
            </TabsContent>
          )}

          <TabsContent value="print" className="mt-3">
            <Card className="space-y-3 p-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">RFID 标签打印</h3>
                <span className="text-[10px] text-muted-foreground">
                  同 SKU 共用 EPC
                </span>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">打印张数</Label>
                <Input
                  type="number"
                  inputMode="numeric"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  className="h-10"
                />
              </div>
              <Button
                className="w-full"
                onClick={() => printMut.mutate()}
                disabled={printMut.isPending}
              >
                <Printer className="mr-1.5 h-3.5 w-3.5" />
                {printMut.isPending ? "提交中…" : "打印并记录"}
              </Button>
              <p className="text-[11px] text-muted-foreground">
                打印完成后请贴到商品上，然后到「扫枪入库」页扫码完成入库。
              </p>
            </Card>
          </TabsContent>

          <TabsContent value="labels" className="mt-3">
            <Card className="divide-y p-0">
              {labels.length === 0 ? (
                <p className="p-4 text-center text-xs text-muted-foreground">
                  暂无打印记录
                </p>
              ) : (
                labels.map((r) => (
                  <div key={r.id} className="flex items-center justify-between p-3 text-xs">
                    <div>
                      <p className="tabular-nums">
                        {new Date(r.printed_at).toLocaleString("zh-CN")}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {r.operator ?? "—"} · {r.status}
                      </p>
                    </div>
                    <span className="font-bold tabular-nums">{r.qty} 张</span>
                  </div>
                ))
              )}
            </Card>
          </TabsContent>

          <TabsContent value="inbound" className="mt-3">
            <Card className="divide-y p-0">
              {lines.length === 0 ? (
                <p className="p-4 text-center text-xs text-muted-foreground">
                  暂无入库记录
                </p>
              ) : (
                lines.map((r) => (
                  <div key={r.id} className="flex items-center justify-between p-3 text-xs">
                    <div>
                      <p className="tabular-nums">
                        {new Date(r.created_at).toLocaleString("zh-CN")}
                      </p>
                      <p className="text-[10px] tabular-nums text-muted-foreground">
                        单价 ¥{Number(r.unit_price).toFixed(2)} · 小计 ¥
                        {Number(r.subtotal).toFixed(2)}
                      </p>
                    </div>
                    <span className="font-bold tabular-nums text-success">+{r.qty}</span>
                  </div>
                ))
              )}
            </Card>
          </TabsContent>

          {sku.notes && (
            <TabsContent value="notes" className="mt-3">
              <Card className="p-3">
                <p className="whitespace-pre-wrap text-xs leading-relaxed">{sku.notes}</p>
              </Card>
            </TabsContent>
          )}
        </Tabs>
      </div>

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
    </MobileShell>
  );
}

function AttrRow({
  label,
  value,
  onCopy,
  mono,
}: {
  label: string;
  value: string;
  onCopy?: () => void;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 p-3">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className={`min-w-0 flex-1 break-all ${mono ? "font-mono text-[11px]" : ""}`}>
        {value}
      </span>
      {onCopy && (
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground active:bg-muted"
          aria-label="复制"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
