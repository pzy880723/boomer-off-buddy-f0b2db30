import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Search, Tags, Package2, ChevronDown, Boxes, Sparkles, LayoutGrid, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/empty-state";
import { StandardSkuDialog } from "@/components/inventory/standard-sku-dialog";
import { CustomSkuDialog } from "@/components/inventory/custom-sku-dialog";
import { BundleSkuDialog } from "@/components/inventory/bundle-sku-dialog";
import {
  StandardProductCard,
  SingleSkuCard,
  StandardProductRow,
  SingleSkuRow,
} from "@/components/inventory/product-card";
import { RowActionsMenu } from "@/components/inventory/row-actions-menu";
import { ProductEditDialog } from "@/components/inventory/product-edit-dialog";
import { SkuEditDialog } from "@/components/inventory/sku-edit-dialog";
import { listSkus, deleteSku, deleteStandardProduct } from "@/lib/inventory.functions";
import { groupStandardSkus, type SkuRow, type StandardProductGroup } from "@/lib/inventory.helpers";
import { useSkuCovers, pickCover } from "@/hooks/use-sku-covers";
import { isInFankuang } from "@/lib/commerce/fankuang";
import { BatchMarksPanel } from "@/components/inventory/batch-marks-panel";
import { getBatchMarkScope, listBatchLocationStocks } from "@/lib/product-marks-batch.functions";
import { useAuthSession } from "@/hooks/use-auth-session";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import type { ReactNode } from "react";

export const Route = createFileRoute("/inventory/skus/")({
  head: () => ({
    meta: [{ title: "BOOMER OFF 商品 SKU · 库存" }, { name: "description", content: "中古商品档案、当前库位批量提示与特色管理" }, { property: "og:title", content: "BOOMER OFF 商品库存" }, { property: "og:description", content: "中古商品档案与当前库位管理" }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" }],
  }),
  component: SkusPage,
});

type DialogKind = "standard" | "custom" | "bundle" | null;
type TabKind = "standard" | "custom" | "bundle";
type ViewMode = "grid" | "list";

function SkusPage() {
  const nav = useNavigate();
  const listFn = useServerFn(listSkus);
  const delSkuFn = useServerFn(deleteSku);
  const delProductFn = useServerFn(deleteStandardProduct);
  const scopeFn = useServerFn(getBatchMarkScope);
  const stockFn = useServerFn(listBatchLocationStocks);
  const { session } = useAuthSession();
  const accountId = session?.user.id ?? "";
  const [locationId, setLocationId] = useState("");
  const scopeQuery = useQuery({ queryKey: ["batch-mark-scope", accountId], queryFn: () => scopeFn(), enabled: Boolean(accountId), refetchInterval: 15000 });
  const scope = scopeQuery.isError ? undefined : scopeQuery.data;
  const activeLocation = scope?.locations.find((l) => l.id === locationId);
  const stockQuery = useQuery({ queryKey: ["batch-location-stocks", accountId, locationId, scope?.roles.join(",")],
    queryFn: () => stockFn({ data: { location_id: locationId } }), enabled: Boolean(activeLocation && accountId), refetchInterval: 15000 });

  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [onlyFankuang, setOnlyFankuang] = useState(false);
  const [openDialog, setOpenDialog] = useState<DialogKind>(null);
  const [tab, setTab] = useState<TabKind>("standard");
  const [view, setView] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return "list";
    return (localStorage.getItem("inv-skus-view") as ViewMode) || "list";
  });

  const [editingGroup, setEditingGroup] = useState<StandardProductGroup | null>(null);
  const [editingSku, setEditingSku] = useState<SkuRow | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const contextKey = JSON.stringify([accountId, scope?.roles, scope?.locations, locationId, tab, search, searchInput, onlyFankuang, stockQuery.isError]);
  const [selectionContext, setSelectionContext] = useState(contextKey);
  const contextValid = selectionContext === contextKey;
  useEffect(() => { setSelected(new Set()); setBatchMode(false); setSelectionContext(contextKey); }, [contextKey]);
  useEffect(() => { if (!activeLocation) setLocationId(""); }, [activeLocation]);
  const selectable = (r: SkuRow, node: ReactNode) =>
    batchMode && contextValid ? (
      <div key={r.id} className="flex items-center gap-2">
        <Checkbox aria-label={`选择 ${r.name}`} className="ml-2" checked={selected.has(r.id)} onCheckedChange={(c) => {
          const next = new Set(selected); if (c === true) next.add(r.id); else next.delete(r.id); setSelected(next);
        }} />
        <div className="min-w-0 flex-1">{node}</div>
      </div>
    ) : node;

  const setViewMode = (v: ViewMode) => {
    setView(v);
    try {
      localStorage.setItem("inv-skus-view", v);
    } catch {
      /* noop */
    }
  };

  const q = useQuery({
    queryKey: ["inv-skus", accountId, search, onlyFankuang],
    queryFn: () => listFn({ data: { search: search || undefined, limit: 500, fankuang: onlyFankuang } }),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    enabled: Boolean(accountId),
  });

  const sourceRows = q.data?.rows;
  const rows = useMemo(() => {
    const stocks = new Map((stockQuery.data ?? []).map((s) => [s.sku_id, s.qty]));
    return ((sourceRows ?? []) as SkuRow[]).filter((r) => !locationId || (activeLocation && !stockQuery.isError && stocks.has(r.id)))
      .map((r) => locationId ? { ...r, stock_qty: Number(stocks.get(r.id) ?? 0), current_location_qty: Number(stocks.get(r.id) ?? 0) } : r)
      .filter((r) => !onlyFankuang || isInFankuang(r));
  }, [sourceRows, onlyFankuang, locationId, activeLocation, stockQuery.data, stockQuery.isError]);
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

  // 批量给所有 SKU 签封面（私桶图）
  const allSkuIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const { covers } = useSkuCovers(allSkuIds, q.dataUpdatedAt);
  const groupCover = (g: StandardProductGroup): string | null => {
    for (const s of g.skus) {
      const c = covers[s.id];
      if (c) return c;
    }
    return pickCover(null, g.image_url);
  };

  const NewMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="bg-gradient-brand hover:opacity-90">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> 新建商品
          <ChevronDown className="ml-1 h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={() => setOpenDialog("standard")}>
          <Tags className="mr-2 h-3.5 w-3.5" /> 标准商品（多价格档）
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

  const productActions = (g: StandardProductGroup) => (
    <RowActionsMenu
      onEdit={() => setEditingGroup(g)}
      onDelete={async () => {
        await delProductFn({ data: { key: g.key } });
        await q.refetch();
      }}
      deleteTitle={`删除商品「${g.name}」？`}
      deleteDescription={`将删除该商品下全部 ${g.skus.length} 个价格档。若任一价格档有库存或入库记录，删除会失败。`}
    />
  );
  const skuActions = (r: SkuRow) => (
    <RowActionsMenu
      onEdit={() => setEditingSku(r)}
      onDelete={async () => {
        await delSkuFn({ data: { id: r.id } });
        await q.refetch();
      }}
      deleteTitle={`删除「${r.name}」？`}
      deleteDescription="若有库存或入库记录，删除会失败。"
    />
  );

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={(v) => { setTab(v as TabKind); setSelected(new Set()); }}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="standard">
              标准商品 <span className="ml-1.5 text-xs text-muted-foreground">{standardGroups.length}</span>
            </TabsTrigger>
            <TabsTrigger value="custom">
              自定义商品 <span className="ml-1.5 text-xs text-muted-foreground">{customRows.length}</span>
            </TabsTrigger>
            <TabsTrigger value="bundle">
              组包商品 <span className="ml-1.5 text-xs text-muted-foreground">{bundleRows.length}</span>
            </TabsTrigger>
          </TabsList>

          <div className="flex items-center gap-2">
            <Select value={locationId || "catalog"} onValueChange={(v) => setLocationId(v === "catalog" ? "" : v)}>
              <SelectTrigger className="h-8 w-44" aria-label="当前门店或授权库位"><SelectValue placeholder="选择当前库位" /></SelectTrigger>
              <SelectContent><SelectItem value="catalog">全部商品（仅浏览）</SelectItem>{(scope?.locations ?? []).map((l) => <SelectItem key={l.id} value={l.id}>{l.name}（{l.kind === "warehouse" ? "仓库" : "门店"}）</SelectItem>)}</SelectContent>
            </Select>
            {tab !== "standard" && !batchMode && (
              <Button size="sm" variant="outline" disabled={!activeLocation || stockQuery.isFetching || stockQuery.isError || scopeQuery.isError || q.isFetching || q.isError} onClick={() => { setBatchMode(true); setSelected(new Set()); setSelectionContext(contextKey); }}>批量</Button>
            )}
            <Button size="sm" variant={onlyFankuang ? "default" : "outline"} aria-pressed={onlyFankuang}
              onClick={() => setOnlyFankuang(!onlyFankuang)}>仅翻筐乐</Button>
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="搜品名 / EPC / 商品编码"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && setSearch(searchInput.trim())}
                className="h-8 pl-7 text-xs"
              />
            </div>
            <ToggleGroup
              type="single"
              value={view}
              onValueChange={(v) => v && setViewMode(v as ViewMode)}
              size="sm"
            >
              <ToggleGroupItem value="grid" aria-label="大图模式" className="h-8 w-8 p-0">
                <LayoutGrid className="h-3.5 w-3.5" />
              </ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label="列表模式" className="h-8 w-8 p-0">
                <List className="h-3.5 w-3.5" />
              </ToggleGroupItem>
            </ToggleGroup>
            <Button variant="outline" size="sm" onClick={() => nav({ to: "/inventory/inbound/new" })}>
              <Package2 className="mr-1.5 h-3.5 w-3.5" /> RFID 入库
            </Button>
            {NewMenu}
          </div>
        </div>

        {batchMode && contextValid && activeLocation && !scopeQuery.isError && !stockQuery.isError && tab !== "standard" && (
          <div className="mt-3">
            <BatchMarksPanel
              key={contextKey}
              contextKey={contextKey}
              locationId={activeLocation.id}
              locationName={activeLocation.name}
              rows={tab === "custom" ? customRows : bundleRows}
              selected={selected}
              onSelectedChange={setSelected}
              onDone={() => { setBatchMode(false); setSelected(new Set()); }}
              onSaved={() => { void q.refetch(); void stockQuery.refetch(); }}
            />
          </div>
        )}
        {q.isFetching && <p className="text-xs text-muted-foreground">正在更新商品筛选…</p>}
        {q.isError && <p role="alert" className="text-xs text-destructive">商品筛选加载失败，当前可能为缓存结果。<Button variant="link" size="sm" onClick={() => q.refetch()}>重试</Button></p>}

        <TabsContent value="standard" className="mt-4">
          {standardGroups.length === 0 ? (
            <EmptyState
              icon={Tags}
              title={onlyFankuang ? "标准商品不参与翻筐乐" : "还没有标准商品"}
              description={onlyFankuang ? "请选择自定义商品，或关闭仅翻筐乐筛选" : "标准商品按类目+品名共享多个价格档,95% 的商品都用这种方式"}
              action={NewMenu}
            />
          ) : view === "grid" ? (
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {standardGroups.map((g) => (
                <StandardProductCard key={g.key} group={g} actions={productActions(g)} coverOverride={groupCover(g)} />
              ))}
            </div>
          ) : (
            <Card className="overflow-hidden">
              {standardGroups.map((g) => (
                <StandardProductRow key={g.key} group={g} actions={productActions(g)} coverOverride={groupCover(g)} />
              ))}
            </Card>
          )}
        </TabsContent>

        <TabsContent value="custom" className="mt-4">
          {customRows.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title={onlyFankuang ? "没有匹配的翻筐乐商品" : "还没有自定义商品"}
              description={onlyFankuang ? "请调整搜索条件，或关闭仅翻筐乐筛选" : "不能归类到标准价格档的大件商品请用「自定义商品」"}
              action={NewMenu}
            />
          ) : view === "grid" ? (
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {customRows.map((r) => selectable(r,
                <SingleSkuCard key={r.id} row={r} actions={skuActions(r)} coverOverride={pickCover(covers[r.id], r.image_url)} />
              ))}
            </div>
          ) : (
            <Card className="overflow-hidden">
              {customRows.map((r) => selectable(r,
                <SingleSkuRow key={r.id} row={r} actions={skuActions(r)} coverOverride={pickCover(covers[r.id], r.image_url)} />
              ))}
            </Card>
          )}
        </TabsContent>

        <TabsContent value="bundle" className="mt-4">
          {bundleRows.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title={onlyFankuang ? "组包商品不参与翻筐乐" : "还没有组包商品"}
              description={onlyFankuang ? "请选择自定义商品，或关闭仅翻筐乐筛选" : "组包商品引用若干已有 SKU，主要用于批发场景"}
              action={NewMenu}
            />
          ) : view === "grid" ? (
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {bundleRows.map((r) => selectable(r,
                <SingleSkuCard key={r.id} row={r} actions={skuActions(r)} coverOverride={pickCover(covers[r.id], r.image_url)} />
              ))}
            </div>
          ) : (
            <Card className="overflow-hidden">
              {bundleRows.map((r) => selectable(r,
                <SingleSkuRow key={r.id} row={r} actions={skuActions(r)} coverOverride={pickCover(covers[r.id], r.image_url)} />
              ))}
            </Card>
          )}
        </TabsContent>
      </Tabs>

      <StandardSkuDialog
        open={openDialog === "standard"}
        onOpenChange={(v) => !v && setOpenDialog(null)}
        onCreated={() => q.refetch()}
      />
      <CustomSkuDialog
        open={openDialog === "custom"}
        onOpenChange={(v) => !v && setOpenDialog(null)}
        onCreated={() => q.refetch()}
      />
      <BundleSkuDialog
        open={openDialog === "bundle"}
        onOpenChange={(v) => !v && setOpenDialog(null)}
        onCreated={() => q.refetch()}
      />

      <ProductEditDialog
        group={editingGroup}
        open={!!editingGroup}
        onOpenChange={(v) => !v && setEditingGroup(null)}
        onSaved={() => q.refetch()}
      />
      <SkuEditDialog
        sku={editingSku}
        open={!!editingSku}
        onOpenChange={(v) => !v && setEditingSku(null)}
        onSaved={() => q.refetch()}
      />
    </div>
  );
}
