import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  Tags,
  Printer,
  Package2,
  ChevronRight,
  Pencil,
  Trash2,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { useMutation } from "@tanstack/react-query";
import { ProductEditDialog } from "@/components/inventory/product-edit-dialog";
import { listSkus, deleteStandardProduct } from "@/lib/inventory.functions";
import {
  CATEGORY_LABEL,
  formatPrice,
  groupStandardSkus,
  type SkuRow,
} from "@/lib/inventory.helpers";

export const Route = createFileRoute("/inventory/products/$code")({
  head: () => ({ meta: [{ title: "标准商品详情 · 库存" }] }),
  component: ProductDetailPage,
});

function ProductDetailPage() {
  const { code } = Route.useParams();
  const nav = useNavigate();
  const listFn = useServerFn(listSkus);
  const delFn = useServerFn(deleteStandardProduct);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const q = useQuery({
    queryKey: ["inv-skus", ""],
    queryFn: () => listFn({ data: { limit: 500 } }),
  });

  const group = useMemo(() => {
    const rows = (q.data?.rows ?? []) as SkuRow[];
    const standards = rows.filter((r) => r.kind === "single" && !r.is_custom_price);
    const groups = groupStandardSkus(standards);
    return groups.find((g) => g.key === code) ?? null;
  }, [q.data, code]);

  const delMut = useMutation({
    mutationFn: async () => {
      if (!group) throw new Error("缺少商品");
      return delFn({ data: { key: group.key } });
    },
    onSuccess: () => {
      toast.success("已删除");
      nav({ to: "/inventory/skus" });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (q.isLoading) return <div className="p-6 text-muted-foreground">加载中…</div>;
  if (!group) {
    return (
      <div className="space-y-4">
        <Link to="/inventory/skus" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary">
          <ArrowLeft className="h-3 w-3" /> 返回 SKU 列表
        </Link>
        <Card className="p-8 text-center text-sm text-muted-foreground">
          找不到该商品。可能已被删除或编码已更改。
        </Card>
      </div>
    );
  }

  const minPrice = group.tiers[0];
  const maxPrice = group.tiers[group.tiers.length - 1];

  return (
    <div className="space-y-4">
      {/* 顶栏：返回 + 操作 */}
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
          <Button size="sm" onClick={() => nav({ to: "/inventory/inbound/new" })}>
            <Package2 className="mr-1.5 h-3.5 w-3.5" /> RFID 入库
          </Button>
        </div>
      </div>

      {/* 主信息：左小图 + 右文案（电商详情风格） */}
      <Card className="p-5">
        <div className="flex flex-col gap-5 sm:flex-row">
          <div className="h-40 w-40 flex-shrink-0 overflow-hidden rounded-lg border bg-muted sm:h-52 sm:w-52">
            {group.image_url ? (
              <img src={group.image_url} alt={group.name} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                <Tags className="h-12 w-12" />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {CATEGORY_LABEL[group.category] ?? group.category} · 标准商品
              </p>
              <h1 className="mt-1 text-xl font-bold leading-tight sm:text-2xl">{group.name}</h1>
            </div>

            {/* 价格区 */}
            <div className="rounded-lg bg-muted/50 p-3">
              <div className="flex items-baseline gap-2">
                <span className="text-xs text-muted-foreground">价格区间</span>
                <span className="text-2xl font-bold text-primary">
                  {formatPrice(minPrice)}
                  {maxPrice !== minPrice && <span className="text-base font-medium"> - {formatPrice(maxPrice)}</span>}
                </span>
                <span className="text-xs text-muted-foreground">· {group.tiers.length} 个价格档</span>
              </div>
            </div>

            {/* 属性网格 */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
              <Attr label="总库存" value={<span className="font-semibold tabular-nums">{group.totalStock} 件</span>} />
              {group.code && <Attr label="商品编码" value={<span className="font-mono">{group.code}</span>} />}
              <Attr label="价格档数" value={`${group.tiers.length}`} />
            </div>

          </div>
        </div>
      </Card>

      {/* 价格档子 SKU 表 */}
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">价格档子 SKU</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              每个价格档 = 一个独立 SKU = 一个价格 = 一段规格编码；RFID 扫描枪扫到对应编码即库存 +1。
            </p>
          </div>
        </div>

        <div className="divide-y rounded-md border">
          {group.skus.map((sku) => (
            <Link
              key={sku.id}
              to="/inventory/skus/$id"
              params={{ id: sku.id }}
              className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/60"
            >
              <Badge className="bg-primary/90 text-primary-foreground tabular-nums">
                {formatPrice(sku.price_tier)}
              </Badge>
              <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                <Printer className="h-3 w-3" />
                {sku.epc}
              </span>
              <span className="ml-auto text-xs tabular-nums">
                库存 <span className="font-semibold">{sku.stock_qty}</span> 件
              </span>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            </Link>
          ))}
        </div>
      </Card>

      {/* 备注 */}
      {group.notes && (
        <Card className="p-4">
          <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">备注</p>
          <p className="whitespace-pre-wrap text-xs leading-relaxed">{group.notes}</p>
        </Card>
      )}

      <ProductEditDialog
        group={group}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={() => q.refetch()}
      />

      <AlertDialog open={confirmDel} onOpenChange={setConfirmDel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除商品「{group.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除该商品下全部 {group.skus.length} 个价格档子 SKU。若任一价格档有库存或入库记录，删除会失败。
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
      <span>{value}</span>
    </div>
  );
}
