import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Plus,
  Search,
  Tags,
  Boxes,
  Sparkles,
  ChevronDown,
  LayoutGrid,
  List,
  Store,
  Package2,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import {
  StandardProductCard,
  SingleSkuCard,
  StandardProductRow,
  SingleSkuRow,
} from "@/components/inventory/product-card";
import { StandardSkuDialog } from "@/components/inventory/standard-sku-dialog";
import { CustomSkuDialog } from "@/components/inventory/custom-sku-dialog";
import { BundleSkuDialog } from "@/components/inventory/bundle-sku-dialog";
import { ReceiveStockDialog } from "@/components/shop-mgmt/receive-stock-dialog";
import { listYouzanShops } from "@/lib/youzan.functions";
import {
  listShopSkus,
  listShopLinksForSkus,
  registerNewSkuAtShop,
  retryBranchListing,
  type ShopSkuRow,
} from "@/lib/shop-products.functions";
import { groupStandardSkus, type SkuRow, type StandardProductGroup } from "@/lib/inventory.helpers";
import { useSkuCovers, pickCover } from "@/hooks/use-sku-covers";

export const Route = createFileRoute("/shop-mgmt/products")({
  head: () => ({
    meta: [
      { title: "门店商品 · 门店管理" },
      { name: "description", content: "以门店为主视角查看和维护商品库存，自动同步到有赞门店后台" },
    ],
  }),
  component: ShopProductsPage,
});

type TabKind = "standard" | "custom" | "bundle";
type ViewMode = "grid" | "list";
type DialogKind = "standard" | "custom" | "bundle" | null;

function ShopProductsPage() {
  const qc = useQueryClient();
  const fetchShops = useServerFn(listYouzanShops);
  const fetchRows = useServerFn(listShopSkus);
  const fetchLinks = useServerFn(listShopLinksForSkus);
  const registerFn = useServerFn(registerNewSkuAtShop);
  const retryFn = useServerFn(retryBranchListing);

  const shopsQ = useQuery({
    queryKey: ["yz-branch-shops"],
    queryFn: () => fetchShops(),
  });
  const branches = useMemo(
    () => (shopsQ.data?.shops ?? []).filter((s) => s.role === "branch"),
    [shopsQ.data],
  );

  const [shopId, setShopId] = useState<string>("");
  const activeShopId = shopId || branches[0]?.id || "";
  const activeShop = branches.find((s) => s.id === activeShopId) ?? null;

  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [tab, setTab] = useState<TabKind>("standard");
  const [view, setView] = useState<ViewMode>("list");
  const [openDialog, setOpenDialog] = useState<DialogKind>(null);
  const [receive, setReceive] = useState<{ sku_id: string; sku_name: string; qty: number } | null>(null);

  const rowsQ = useQuery({
    queryKey: ["shop-skus", activeShopId, search],
    queryFn: () => fetchRows({ data: { shop_id: activeShopId, search: search || undefined } }),
    enabled: !!activeShopId,
  });
  const rows = (rowsQ.data?.rows ?? []) as ShopSkuRow[];

  const linksQ = useQuery({
    queryKey: ["shop-links", activeShopId, rows.map((r) => r.id).join(",")],
    queryFn: () =>
      fetchLinks({ data: { shop_id: activeShopId, sku_ids: rows.map((r) => r.id) } }),
    enabled: !!activeShopId && rows.length > 0,
  });
  const links = linksQ.data?.links ?? {};

  const { standardGroups, customRows, bundleRows } = useMemo(() => {
    const std = rows.filter((r) => r.kind === "single" && !r.is_custom_price);
    const cus = rows.filter((r) => r.kind === "single" && r.is_custom_price);
    const bun = rows.filter((r) => r.kind === "bundle");
    return {
      standardGroups: groupStandardSkus(std as unknown as SkuRow[]),
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

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["shop-skus"] });
    qc.invalidateQueries({ queryKey: ["shop-links"] });
  };

  const handleNewSkuCreated = async (skuIds: string[]) => {
    if (!activeShopId) return;
    try {
      const r = await registerFn({
        data: { shop_id: activeShopId, sku_ids: skuIds, qty_each: 1 },
      });
      const errCount = r.results.filter((x) => x.listing_error).length;
      if (errCount > 0) {
        toast.warning(`已入库 ${r.results.length} 件；${errCount} 件上架有赞失败，可在卡片上点重试`);
      } else {
        toast.success(`已入库并同步上架 ${r.results.length} 件`);
      }
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const handleRetry = async (sku_id: string) => {
    if (!activeShopId) return;
    const r = await retryFn({ data: { shop_id: activeShopId, sku_id } });
    if (r.ok) toast.success("已重新上架到有赞");
    else toast.error(r.error ?? "上架失败");
    refresh();
  };

  const NewMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" disabled={!activeShopId} className="bg-gradient-brand hover:opacity-90">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> 新建商品
          <ChevronDown className="ml-1 h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={() => setOpenDialog("standard")}>
          <Tags className="mr-2 h-3.5 w-3.5" /> 标准商品（多价格档）
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setOpenDialog("custom")}>
          <Sparkles className="mr-2 h-3.5 w-3.5" /> 自定义商品（孤品）
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setOpenDialog("bundle")}>
          <Boxes className="mr-2 h-3.5 w-3.5" /> 组包商品
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const renderLinkBadge = (sku_id: string) => {
    const l = links[sku_id];
    if (!l) return null;
    if (l.status === "linked" && l.yz_item_id) {
      return (
        <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-700 text-[10px] dark:text-emerald-300">
          <CheckCircle2 className="h-2.5 w-2.5" /> 已同步有赞
        </Badge>
      );
    }
    if (l.status === "error") {
      return (
        <Badge
          variant="outline"
          className="gap-1 border-rose-500/40 text-rose-700 text-[10px] dark:text-rose-300 cursor-pointer"
          title={l.last_error ?? undefined}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleRetry(sku_id);
          }}
        >
          <AlertCircle className="h-2.5 w-2.5" /> 上架失败 · 点重试
        </Badge>
      );
    }
    return null;
  };

  const skuActions = (r: ShopSkuRow) => (
    <div className="flex items-center gap-1">
      {renderLinkBadge(r.id)}
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-[11px]"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setReceive({ sku_id: r.id, sku_name: r.name, qty: r.stock_qty });
        }}
      >
        <Package2 className="mr-1 h-3 w-3" /> 库存
      </Button>
    </div>
  );

  const groupActions = (g: StandardProductGroup) => (
    <div className="flex items-center gap-1">
      {g.skus.length > 0 && renderLinkBadge(g.skus[0].id)}
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-[11px]"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const first = g.skus[0];
          if (first) setReceive({ sku_id: first.id, sku_name: `${g.name} · ¥${first.price_tier}`, qty: first.stock_qty });
        }}
      >
        <Package2 className="mr-1 h-3 w-3" /> 库存
      </Button>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="门店商品"
        description="以门店为主视角管理商品和库存。新建/入库时自动同步到该门店的有赞后台。"
        meta={
          activeShop ? (
            <>
              <Store className="mr-1 inline h-3 w-3" />
              {activeShop.shop_name}
              <span className="ml-2 text-border">·</span>
              <span className="ml-2">{rows.length} 件商品</span>
            </>
          ) : (
            <span className="text-muted-foreground">请先选择门店</span>
          )
        }
      />

      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <Select value={activeShopId} onValueChange={setShopId}>
            <SelectTrigger className="h-9 w-[260px]">
              <SelectValue placeholder="选择门店" />
            </SelectTrigger>
            <SelectContent>
              {branches.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  暂无分店，请先到有赞页面导入
                </div>
              ) : (
                branches.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    🏬 {s.shop_name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜品名 / EPC / 商品编码（回车）"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && setSearch(searchInput.trim())}
              className="h-9 pl-8 text-xs"
            />
          </div>
          <ToggleGroup type="single" value={view} onValueChange={(v) => v && setView(v as ViewMode)} size="sm">
            <ToggleGroupItem value="grid" className="h-8 w-8 p-0">
              <LayoutGrid className="h-3.5 w-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem value="list" className="h-8 w-8 p-0">
              <List className="h-3.5 w-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
          {NewMenu}
        </div>
      </Card>

      {rowsQ.isLoading && (
        <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> 加载中…
        </p>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKind)}>
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

        <TabsContent value="standard" className="mt-4">
          {standardGroups.length === 0 ? (
            <EmptyState
              icon={Tags}
              title="该门店还没有标准商品"
              description="新建后会自动在这家门店入库 1 件、并同步上架到有赞门店后台"
              action={NewMenu}
            />
          ) : view === "grid" ? (
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {standardGroups.map((g) => (
                <StandardProductCard key={g.key} group={g} actions={groupActions(g)} coverOverride={groupCover(g)} />
              ))}
            </div>
          ) : (
            <Card className="overflow-hidden">
              {standardGroups.map((g) => (
                <StandardProductRow key={g.key} group={g} actions={groupActions(g)} coverOverride={groupCover(g)} />
              ))}
            </Card>
          )}
        </TabsContent>

        <TabsContent value="custom" className="mt-4">
          {customRows.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="该门店还没有自定义商品"
              description="孤品商品：每家门店独有，新建即上架并库存为 1"
              action={NewMenu}
            />
          ) : view === "grid" ? (
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {customRows.map((r) => (
                <SingleSkuCard
                  key={r.id}
                  row={r as unknown as SkuRow}
                  actions={skuActions(r)}
                  coverOverride={pickCover(covers[r.id], r.image_url)}
                />
              ))}
            </div>
          ) : (
            <Card className="overflow-hidden">
              {customRows.map((r) => (
                <SingleSkuRow
                  key={r.id}
                  row={r as unknown as SkuRow}
                  actions={skuActions(r)}
                  coverOverride={pickCover(covers[r.id], r.image_url)}
                />
              ))}
            </Card>
          )}
        </TabsContent>

        <TabsContent value="bundle" className="mt-4">
          {bundleRows.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title="该门店还没有组包商品"
              description="组包引用若干已有 SKU，新建即在本店上架"
              action={NewMenu}
            />
          ) : view === "grid" ? (
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {bundleRows.map((r) => (
                <SingleSkuCard
                  key={r.id}
                  row={r as unknown as SkuRow}
                  actions={skuActions(r)}
                  coverOverride={pickCover(covers[r.id], r.image_url)}
                />
              ))}
            </div>
          ) : (
            <Card className="overflow-hidden">
              {bundleRows.map((r) => (
                <SingleSkuRow
                  key={r.id}
                  row={r as unknown as SkuRow}
                  actions={skuActions(r)}
                  coverOverride={pickCover(covers[r.id], r.image_url)}
                />
              ))}
            </Card>
          )}
        </TabsContent>
      </Tabs>

      <StandardSkuDialog
        open={openDialog === "standard"}
        onOpenChange={(v) => !v && setOpenDialog(null)}
        onCreated={(res) => {
          const ids = res?.skus?.map((s) => s.id) ?? [];
          if (ids.length > 0) void handleNewSkuCreated(ids);
        }}
      />
      <CustomSkuDialog
        open={openDialog === "custom"}
        onOpenChange={(v) => !v && setOpenDialog(null)}
        onCreated={(res) => {
          const id = res?.sku?.id;
          if (id) void handleNewSkuCreated([id]);
        }}
      />
      <BundleSkuDialog
        open={openDialog === "bundle"}
        onOpenChange={(v) => !v && setOpenDialog(null)}
        onCreated={(res) => {
          const id = res?.sku?.id;
          if (id) void handleNewSkuCreated([id]);
        }}
      />

      {receive && activeShop && (
        <ReceiveStockDialog
          open={!!receive}
          onOpenChange={(o) => !o && setReceive(null)}
          shopId={activeShopId}
          shopName={activeShop.shop_name}
          skuId={receive.sku_id}
          skuName={receive.sku_name}
          currentQty={receive.qty}
          onSuccess={refresh}
        />
      )}
    </div>
  );
}
