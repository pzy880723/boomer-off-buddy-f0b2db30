import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Search, Tags, Printer, Boxes } from "lucide-react";
import { MobileShell } from "@/components/mobile/mobile-shell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import { listSkus } from "@/lib/inventory.functions";
import { CATEGORY_LABEL, SKU_KIND_LABEL, formatPrice, type SkuKind } from "@/lib/inventory.helpers";
import {
  CustomSkuForm,
  useCustomSkuMutation,
} from "@/components/inventory/custom-sku-dialog";
import { emptySkuMeta, type SkuMetaState } from "@/components/inventory/sku-meta-fields";

export const Route = createFileRoute("/m/skus")({
  head: () => ({ meta: [{ title: "商品 SKU · 移动" }] }),
  component: MSkusPage,
});

function MSkusPage() {
  const listFn = useServerFn(listSkus);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [openNew, setOpenNew] = useState(false);

  const q = useQuery({
    queryKey: ["m-inv-skus", search],
    queryFn: () => listFn({ data: { search: search || undefined, limit: 200 } }),
  });
  const rows = q.data?.rows ?? [];

  return (
    <MobileShell
      title="商品 SKU"
      back="/m"
      rightSlot={
        <Button size="sm" className="h-8 px-2" onClick={() => setOpenNew(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> 新建
        </Button>
      }
    >
      <div className="space-y-3 p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜品名 / EPC / 编码，回车搜索"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setSearch(searchInput.trim())}
            className="h-10 pl-9"
          />
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={Tags}
            title="还没有 SKU"
            description="点击右上「新建」创建一个自定义商品"
          />
        ) : (
          <div className="space-y-2">
            {rows.map((r) => {
              const skuCode = (r as { sku_code?: string | null }).sku_code;
              const isBundle = r.kind === "bundle";
              return (
                <Link
                  key={r.id}
                  to="/inventory/skus/$id"
                  params={{ id: r.id }}
                  className="flex gap-3 rounded-xl border bg-card p-2.5 active:bg-muted"
                >
                  <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-muted">
                    {r.image_url ? (
                      <img src={r.image_url} alt={r.name} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                        <Tags className="h-5 w-5" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <Badge className="bg-primary/90 text-primary-foreground">{formatPrice(r.price_tier)}</Badge>
                      {isBundle && (
                        <Badge variant="secondary">
                          <Boxes className="mr-0.5 h-2.5 w-2.5" />组包
                        </Badge>
                      )}
                      {r.kind === "pack" && <Badge variant="secondary">组包·{r.pack_pieces ?? "?"}</Badge>}
                      {(r as { is_custom_price?: boolean }).is_custom_price && !isBundle && (
                        <Badge variant="outline">自定义</Badge>
                      )}
                      <span className="ml-auto text-[11px] text-muted-foreground">库存 {r.stock_qty}</span>
                    </div>
                    <p className="line-clamp-1 text-sm font-medium">{r.name}</p>
                    <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <span>{CATEGORY_LABEL[r.category] ?? r.category} · {SKU_KIND_LABEL[r.kind as SkuKind] ?? r.kind}</span>
                      <span className="ml-auto inline-flex items-center gap-1 font-mono">
                        <Printer className="h-2.5 w-2.5" />
                        {r.epc}
                      </span>
                    </p>
                    {skuCode && (
                      <p className="font-mono text-[10px] text-muted-foreground">商品编码：{skuCode}</p>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <MNewCustomSkuSheet open={openNew} onOpenChange={setOpenNew} onCreated={() => q.refetch()} />
    </MobileShell>
  );
}

function MNewCustomSkuSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated?: () => void;
}) {
  const [meta, setMeta] = useState<SkuMetaState>(emptySkuMeta);
  const [price, setPrice] = useState("");
  const reset = () => { setMeta(emptySkuMeta); setPrice(""); };
  const mut = useCustomSkuMutation(() => {
    reset();
    onOpenChange(false);
    onCreated?.();
  });

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <SheetContent side="bottom" className="h-[92dvh] overflow-y-auto p-0">
        <SheetHeader className="border-b p-4">
          <SheetTitle>新建自定义商品</SheetTitle>
        </SheetHeader>
        <div className="p-4 pb-24">
          <CustomSkuForm meta={meta} setMeta={setMeta} price={price} setPrice={setPrice} mobile />
        </div>
        <SheetFooter className="fixed inset-x-0 bottom-0 border-t bg-background p-3 pb-[calc(env(safe-area-inset-bottom)+12px)]">
          <Button className="w-full" onClick={() => mut.mutate({ meta, price })} disabled={mut.isPending}>
            {mut.isPending ? "创建中…" : "创建并生成 EPC"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
