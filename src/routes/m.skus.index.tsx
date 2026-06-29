import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Search, Tags, Printer, Boxes, Sparkles, ChevronDown } from "lucide-react";
import { MobileShell } from "@/components/mobile/mobile-shell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/empty-state";
import { listSkus } from "@/lib/inventory.functions";
import {
  CATEGORY_LABEL,
  formatPrice,
  groupStandardSkus,
  type SkuRow,
  type StandardProductGroup,
} from "@/lib/inventory.helpers";
import { useSkuCovers, pickCover } from "@/hooks/use-sku-covers";
import {
  CustomSkuForm,
  useCustomSkuMutation,
} from "@/components/inventory/custom-sku-dialog";
import { StandardSkuDialog } from "@/components/inventory/standard-sku-dialog";
import { BundleSkuDialog } from "@/components/inventory/bundle-sku-dialog";
import { emptySkuMeta, type SkuMetaState } from "@/components/inventory/sku-meta-fields";
import { SmartSkuCapture } from "@/components/inventory/smart-sku-capture";

export const Route = createFileRoute("/m/skus/")({
  head: () => ({ meta: [{ title: "商品 SKU · 移动" }] }),
  component: MSkusPage,
});

type TabKind = "custom" | "bundle" | "standard";
type DialogKind = "standard" | "custom" | "bundle" | null;

function MSkusPage() {
  const listFn = useServerFn(listSkus);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [openDialog, setOpenDialog] = useState<DialogKind>(null);
  const [tab, setTab] = useState<TabKind>("custom");

  const q = useQuery({
    queryKey: ["m-inv-skus", search],
    queryFn: () => listFn({ data: { search: search || undefined, limit: 500 } }),
  });
  const rows = (q.data?.rows ?? []) as SkuRow[];
  const { standardGroups, customRows, bundleRows } = useMemo(() => {
    const std = rows.filter((r) => r.kind === "single" && !r.is_custom_price);
    const cus = rows.filter((r) => r.kind === "single" && r.is_custom_price);
    const bun = rows.filter((r) => r.kind === "bundle");
    return {
      standardGroups: groupStandardSkus(std),
      customRows: cus,
      bundleRows: bun,
    };
  }, [rows]);

  const allSkuIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const { covers } = useSkuCovers(allSkuIds);
  const groupCover = (g: StandardProductGroup): string | null => {
    for (const s of g.skus) {
      const c = covers[s.id];
      if (c) return c;
    }
    return pickCover(null, g.image_url);
  };

  const NewBtn = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="h-10 px-3 shrink-0">
          <Plus className="mr-1 h-3.5 w-3.5" /> 新建
          <ChevronDown className="ml-0.5 h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={() => setOpenDialog("standard")}>
          <Tags className="mr-2 h-3.5 w-3.5" /> 标准商品
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setOpenDialog("custom")}>
          <Sparkles className="mr-2 h-3.5 w-3.5" /> 自定义商品
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setOpenDialog("bundle")}>
          <Boxes className="mr-2 h-3.5 w-3.5" /> 组包商品
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <MobileShell title="商品 SKU" back="/m">
      <div className="space-y-3 p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜品名 / EPC / 编码，回车搜索"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && setSearch(searchInput.trim())}
              className="h-10 pl-9"
            />
          </div>
          {NewBtn}
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKind)}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="custom">
              自定义 <span className="ml-1 text-[10px] text-muted-foreground">{customRows.length}</span>
            </TabsTrigger>
            <TabsTrigger value="bundle">
              组包 <span className="ml-1 text-[10px] text-muted-foreground">{bundleRows.length}</span>
            </TabsTrigger>
            <TabsTrigger value="standard">
              标准 <span className="ml-1 text-[10px] text-muted-foreground">{standardGroups.length}</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="custom" className="mt-3 space-y-2">
            {customRows.length === 0 ? (
              <EmptyState icon={Sparkles} title="还没有自定义商品" description="点右上「新建」→ 自定义商品" />
            ) : (
              customRows.map((r) => <MSingleRow key={r.id} row={r} cover={pickCover(covers[r.id], r.image_url)} />)
            )}
          </TabsContent>

          <TabsContent value="bundle" className="mt-3 space-y-2">
            {bundleRows.length === 0 ? (
              <EmptyState icon={Boxes} title="还没有组包商品" />
            ) : (
              bundleRows.map((r) => <MSingleRow key={r.id} row={r} cover={pickCover(covers[r.id], r.image_url)} />)
            )}
          </TabsContent>

          <TabsContent value="standard" className="mt-3 space-y-2">
            {standardGroups.length === 0 ? (
              <EmptyState icon={Tags} title="还没有标准商品" description="点右上「新建」开始" />
            ) : (
              standardGroups.map((g) => <MStandardRow key={g.key} group={g} cover={groupCover(g)} />)
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* 自定义商品移动端用底部 Sheet */}
      <MNewCustomSkuSheet
        open={openDialog === "custom"}
        onOpenChange={(v) => !v && setOpenDialog(null)}
        onCreated={() => q.refetch()}
      />
      {/* 标准 / 组包暂复用桌面对话框（移动端可滚动） */}
      <StandardSkuDialog
        open={openDialog === "standard"}
        onOpenChange={(v) => !v && setOpenDialog(null)}
        onCreated={() => q.refetch()}
      />
      <BundleSkuDialog
        open={openDialog === "bundle"}
        onOpenChange={(v) => !v && setOpenDialog(null)}
        onCreated={() => q.refetch()}
      />
    </MobileShell>
  );
}

function MStandardRow({ group, cover }: { group: StandardProductGroup; cover?: string | null }) {
  const visibleTiers = group.tiers.slice(0, 3);
  const remaining = group.tiers.length - visibleTiers.length;
  const src = cover ?? group.image_url;
  return (
    <Link
      to="/m/products/$code"
      params={{ code: encodeURIComponent(group.key) }}
      className="flex gap-3 rounded-xl border bg-card p-2.5 active:bg-muted"
    >
      <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-muted">
        {src ? (
          <img src={src} alt={group.name} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <Tags className="h-5 w-5" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1">
          {visibleTiers.map((t) => (
            <Badge key={t} className="bg-primary/90 text-primary-foreground">
              {formatPrice(t)}
            </Badge>
          ))}
          {remaining > 0 && <Badge variant="secondary">+{remaining}</Badge>}
          <span className="ml-auto text-[11px] text-muted-foreground">库存 {group.totalStock}</span>
        </div>
        <p className="line-clamp-1 text-sm font-medium">{group.name}</p>
        <p className="text-[10px] text-muted-foreground">
          {CATEGORY_LABEL[group.category] ?? group.category} · {group.tiers.length} 个价格档
          {group.code && <span className="ml-1 font-mono">· {group.code}</span>}
        </p>
      </div>
    </Link>
  );
}

function MSingleRow({ row, cover }: { row: SkuRow; cover?: string | null }) {
  const isBundle = row.kind === "bundle";
  const src = cover ?? row.image_url;
  return (
    <Link
      to="/m/skus/$id"
      params={{ id: row.id }}
      className="flex gap-3 rounded-xl border bg-card p-2.5 active:bg-muted"
    >
      <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-muted">
        {src ? (
          <img src={src} alt={row.name} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <Tags className="h-5 w-5" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-1.5">
          <Badge className="bg-primary/90 text-primary-foreground">{formatPrice(row.price_tier)}</Badge>
          {isBundle ? (
            <Badge variant="secondary">
              <Boxes className="mr-0.5 h-2.5 w-2.5" />组包
            </Badge>
          ) : (
            <Badge variant="outline">自定义</Badge>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground">库存 {row.stock_qty}</span>
        </div>
        <p className="line-clamp-1 text-sm font-medium">{row.name}</p>
        <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span>{CATEGORY_LABEL[row.category] ?? row.category}</span>
          <span className="ml-auto inline-flex items-center gap-1 font-mono">
            <Printer className="h-2.5 w-2.5" />
            {row.epc}
          </span>
        </p>
      </div>
    </Link>
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
  const [smartOpen, setSmartOpen] = useState(false);
  const reset = () => {
    setMeta(emptySkuMeta);
    setPrice("");
    setSmartOpen(false);
  };
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
        <div className="space-y-3 p-4 pb-24">
          {smartOpen ? (
            <SmartSkuCapture
              onApply={(patch: Partial<SkuMetaState>) => setMeta({ ...meta, ...patch })}
              onClose={() => setSmartOpen(false)}
            />
          ) : (
            <Button
              variant="outline"
              className="w-full justify-center"
              onClick={() => setSmartOpen(true)}
            >
              <Sparkles className="mr-2 h-4 w-4 text-primary" />
              智能新建（拍照自动识别类目 / 品名 / 描述）
            </Button>
          )}
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
