import { useMemo, useState } from "react";
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

export const Route = createFileRoute("/inventory/skus/")({
  head: () => ({
    meta: [{ title: "商品 SKU · 库存" }, { name: "description", content: "中古杂货 SKU 档案与 RFID 标签" }],
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

  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [openDialog, setOpenDialog] = useState<DialogKind>(null);
  const [tab, setTab] = useState<TabKind>("standard");
  const [view, setView] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return "list";
    return (localStorage.getItem("inv-skus-view") as ViewMode) || "list";
  });

  const [editingGroup, setEditingGroup] = useState<StandardProductGroup | null>(null);
  const [editingSku, setEditingSku] = useState<SkuRow | null>(null);

  const setViewMode = (v: ViewMode) => {
    setView(v);
    try {
      localStorage.setItem("inv-skus-view", v);
    } catch {
      /* noop */
    }
  };

  const q = useQuery({
    queryKey: ["inv-skus", search],
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
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKind)}>
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
              <Package2 className="mr-1.5 h-3.5 w-3.5" /> 扫枪入库
            </Button>
            {NewMenu}
          </div>
        </div>

        <TabsContent value="standard" className="mt-4">
          {standardGroups.length === 0 ? (
            <EmptyState
              icon={Tags}
              title="还没有标准商品"
              description="标准商品按类目+品名共享多个价格档,95% 的商品都用这种方式"
              action={NewMenu}
            />
          ) : view === "grid" ? (
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {standardGroups.map((g) => (
                <StandardProductCard key={g.key} group={g} actions={productActions(g)} />
              ))}
            </div>
          ) : (
            <Card className="overflow-hidden">
              {standardGroups.map((g) => (
                <StandardProductRow key={g.key} group={g} actions={productActions(g)} />
              ))}
            </Card>
          )}
        </TabsContent>

        <TabsContent value="custom" className="mt-4">
          {customRows.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="还没有自定义商品"
              description="不能归类到标准价格档的大件商品请用「自定义商品」"
              action={NewMenu}
            />
          ) : view === "grid" ? (
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {customRows.map((r) => (
                <SingleSkuCard key={r.id} row={r} actions={skuActions(r)} />
              ))}
            </div>
          ) : (
            <Card className="overflow-hidden">
              {customRows.map((r) => (
                <SingleSkuRow key={r.id} row={r} actions={skuActions(r)} />
              ))}
            </Card>
          )}
        </TabsContent>

        <TabsContent value="bundle" className="mt-4">
          {bundleRows.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title="还没有组包商品"
              description="组包商品引用若干已有 SKU，主要用于批发场景"
              action={NewMenu}
            />
          ) : view === "grid" ? (
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {bundleRows.map((r) => (
                <SingleSkuCard key={r.id} row={r} actions={skuActions(r)} />
              ))}
            </div>
          ) : (
            <Card className="overflow-hidden">
              {bundleRows.map((r) => (
                <SingleSkuRow key={r.id} row={r} actions={skuActions(r)} />
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
