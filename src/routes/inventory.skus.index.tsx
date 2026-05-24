import { useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Search, Tags, Package2, ChevronDown, Boxes, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StandardSkuDialog } from "@/components/inventory/standard-sku-dialog";
import { CustomSkuDialog } from "@/components/inventory/custom-sku-dialog";
import { BundleSkuDialog } from "@/components/inventory/bundle-sku-dialog";
import { StandardProductCard, SingleSkuCard } from "@/components/inventory/product-card";
import { listSkus } from "@/lib/inventory.functions";
import { groupStandardSkus, type SkuRow } from "@/lib/inventory.helpers";

export const Route = createFileRoute("/inventory/skus/")({
  head: () => ({
    meta: [{ title: "商品 SKU · 库存" }, { name: "description", content: "中古杂货 SKU 档案与 RFID 标签" }],
  }),
  component: SkusPage,
});

type DialogKind = "standard" | "custom" | "bundle" | null;
type TabKind = "standard" | "custom" | "bundle";

function SkusPage() {
  const nav = useNavigate();
  const listFn = useServerFn(listSkus);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [openDialog, setOpenDialog] = useState<DialogKind>(null);
  const [tab, setTab] = useState<TabKind>("standard");

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

  const totalStock = rows.reduce((s, r) => s + (r.stock_qty ?? 0), 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="商品 SKU"
        description="标准商品按 类目+品名 共享多个价格档；自定义、组包独立成 SKU"
        meta={
          <span>
            标准 {standardGroups.length} 个 · 自定义 {customRows.length} · 组包 {bundleRows.length} · 在库合计 {totalStock} 件
          </span>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => nav({ to: "/inventory/inbound/new" })}>
              <Package2 className="mr-1.5 h-3.5 w-3.5" /> 扫枪入库
            </Button>
            {NewMenu}
          </>
        }
      />

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
        </div>

        <TabsContent value="standard" className="mt-4">
          {standardGroups.length === 0 ? (
            <EmptyState
              icon={Tags}
              title="还没有标准商品"
              description="标准商品按类目+品名共享多个价格档，95% 的商品都用这种方式"
              action={NewMenu}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {standardGroups.map((g) => (
                <StandardProductCard key={g.key} group={g} />
              ))}
            </div>
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
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {customRows.map((r) => (
                <SingleSkuCard key={r.id} row={r} />
              ))}
            </div>
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
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {bundleRows.map((r) => (
                <SingleSkuCard key={r.id} row={r} />
              ))}
            </div>
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
    </div>
  );
}
