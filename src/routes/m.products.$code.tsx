import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Tags,
  Printer,
  ChevronRight,
  Pencil,
  Trash2,
  Loader2,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import { MobileShell } from "@/components/mobile/mobile-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { ProductEditDialog } from "@/components/inventory/product-edit-dialog";
import { listSkus, deleteStandardProduct } from "@/lib/inventory.functions";
import { toThumbUrl } from "@/lib/image";
import {
  CATEGORY_LABEL,
  formatPrice,
  groupStandardSkus,
  type SkuRow,
} from "@/lib/inventory.helpers";

export const Route = createFileRoute("/m/products/$code")({
  head: () => ({ meta: [{ title: "标准商品详情 · 移动" }] }),
  component: MProductDetail,
});

function MProductDetail() {
  const { code } = Route.useParams();
  const nav = useNavigate();
  const listFn = useServerFn(listSkus);
  const delFn = useServerFn(deleteStandardProduct);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const q = useQuery({
    queryKey: ["m-inv-skus", ""],
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
      nav({ to: "/m/skus" });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const copy = (text: string, label: string) => {
    try {
      navigator.clipboard?.writeText(text);
      toast.success(`${label}已复制`);
    } catch {
      // ignore
    }
  };

  const rightSlot = group ? (
    <>
      <button
        type="button"
        onClick={() => setEditOpen(true)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground active:bg-muted"
        aria-label="编辑"
      >
        <Pencil className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => setConfirmDel(true)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-destructive active:bg-muted"
        aria-label="删除"
      >
        <Trash2 className="h-4 w-4" />
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
  if (!group) {
    return (
      <MobileShell title="商品详情" back="/m/skus">
        <div className="p-6 text-sm text-muted-foreground">找不到该商品，可能已被删除。</div>
      </MobileShell>
    );
  }

  const minPrice = group.tiers[0];
  const maxPrice = group.tiers[group.tiers.length - 1];

  return (
    <MobileShell title="商品详情" back="/m/skus" rightSlot={rightSlot}>
      <div className="space-y-3 p-3">
        {/* 主图 + 标题 + 价格区间 */}
        <Card className="overflow-hidden p-0">
          <div className="aspect-[4/3] w-full bg-muted">
            {group.image_url ? (
              <img src={toThumbUrl(group.image_url, 720) ?? group.image_url} alt={group.name} loading="eager" decoding="async" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                <Tags className="h-10 w-10" />
              </div>
            )}
          </div>
          <div className="space-y-2 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">
                {CATEGORY_LABEL[group.category] ?? group.category}
              </Badge>
              <Badge variant="outline">标准商品</Badge>
            </div>
            <h1 className="text-lg font-bold leading-snug">{group.name}</h1>
            <div className="flex items-baseline gap-3 pt-1">
              <span className="text-2xl font-bold text-primary">
                {formatPrice(minPrice)}
                {maxPrice !== minPrice && (
                  <span className="text-base font-medium"> ~ {formatPrice(maxPrice)}</span>
                )}
              </span>
              <span className="text-xs text-muted-foreground">· {group.tiers.length} 档</span>
              <span className="ml-auto text-sm tabular-nums text-muted-foreground">
                库存 {group.totalStock} 件
              </span>
            </div>
          </div>
        </Card>

        {/* 属性 */}
        <Card className="divide-y p-0 text-xs">
          {group.code && (
            <AttrRow label="商品编码" value={group.code} mono onCopy={() => copy(group.code!, "编码")} />
          )}
          {group.weight_g != null && (
            <AttrRow label="单件重量" value={`${group.weight_g} g`} />
          )}
          <AttrRow label="价格档数" value={`${group.tiers.length} 档`} />
        </Card>

        {/* 价格档列表 */}
        <Card className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">价格档子 SKU</h3>
            <span className="text-[10px] text-muted-foreground">点击进入打印 / 入库</span>
          </div>
          <div className="divide-y rounded-md border">
            {group.skus.map((sku) => (
              <Link
                key={sku.id}
                to="/m/skus/$id"
                params={{ id: sku.id }}
                className="flex items-center gap-2 px-3 py-2.5 active:bg-muted"
              >
                <Badge className="bg-primary/90 text-primary-foreground tabular-nums">
                  {formatPrice(sku.price_tier)}
                </Badge>
                <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                  <Printer className="h-3 w-3" />
                  {sku.epc}
                </span>
                <span className="ml-auto text-xs tabular-nums">
                  库存 <span className="font-semibold">{sku.stock_qty}</span>
                </span>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              </Link>
            ))}
          </div>
        </Card>

        {/* 备注 */}
        {group.notes && (
          <Card className="p-3">
            <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">备注</p>
            <p className="whitespace-pre-wrap text-xs leading-relaxed">{group.notes}</p>
          </Card>
        )}
      </div>

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
