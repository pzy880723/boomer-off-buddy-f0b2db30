import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Search, Tags, Package2, Printer, ChevronDown, Boxes, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { listSkus } from "@/lib/inventory.functions";
import {
  CATEGORY_LABEL,
  SKU_KIND_LABEL,
  formatPrice,
  type SkuKind,
} from "@/lib/inventory.helpers";

export const Route = createFileRoute("/inventory/skus/")({
  head: () => ({
    meta: [{ title: "商品 SKU · 库存" }, { name: "description", content: "中古杂货 SKU 档案与 RFID 标签" }],
  }),
  component: SkusPage,
});

type DialogKind = "standard" | "custom" | "bundle" | null;

function SkusPage() {
  const nav = useNavigate();
  const listFn = useServerFn(listSkus);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [openDialog, setOpenDialog] = useState<DialogKind>(null);

  const q = useQuery({
    queryKey: ["inv-skus", search],
    queryFn: () => listFn({ data: { search: search || undefined, limit: 300 } }),
  });

  const rows = q.data?.rows ?? [];

  const NewMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="bg-gradient-brand hover:opacity-90">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> 新建 SKU
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

  return (
    <div className="space-y-4">
      <PageHeader
        title="商品 SKU"
        description="按 类目 + 价格 + 品名 共用 EPC；组包商品作为独立 SKU"
        meta={
          <span>
            共 {rows.length} 个 SKU · 在库合计 {rows.reduce((s, r) => s + (r.stock_qty ?? 0), 0)} 件
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
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Tags}
          title="还没有 SKU"
          description="点击右上「新建 SKU」创建第一个商品档案"
          action={NewMenu}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {rows.map((r) => {
            const isBundle = r.kind === "bundle";
            const skuCode = (r as { sku_code?: string | null }).sku_code;
            const bundleItems = (r as { bundle_items?: unknown[] }).bundle_items;
            return (
              <Link key={r.id} to="/inventory/skus/$id" params={{ id: r.id }} className="block">
                <Card className="group h-full overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-card-hover">
                  <div className="relative aspect-square overflow-hidden bg-muted">
                    {r.image_url ? (
                      <img
                        src={r.image_url}
                        alt={r.name}
                        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                        <Tags className="h-10 w-10" />
                      </div>
                    )}
                    <div className="absolute left-2 top-2 flex flex-wrap gap-1">
                      <Badge className="bg-primary/90 text-primary-foreground">{formatPrice(r.price_tier)}</Badge>
                      {isBundle && (
                        <Badge variant="secondary">
                          <Boxes className="mr-0.5 h-2.5 w-2.5" />
                          组包·{Array.isArray(bundleItems) ? bundleItems.length : "?"}
                        </Badge>
                      )}
                      {r.kind === "pack" && <Badge variant="secondary">组包·{r.pack_pieces ?? "?"}</Badge>}
                      {(r as { is_custom_price?: boolean }).is_custom_price && !isBundle && (
                        <Badge variant="outline" className="bg-background/80 backdrop-blur">自定义价</Badge>
                      )}
                    </div>
                    <div className="absolute right-2 top-2">
                      <Badge variant="outline" className="bg-background/80 backdrop-blur">
                        库存 {r.stock_qty}
                      </Badge>
                    </div>
                  </div>
                  <div className="p-3">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {CATEGORY_LABEL[r.category] ?? r.category} · {SKU_KIND_LABEL[r.kind as SkuKind] ?? r.kind}
                    </p>
                    <p className="mt-1 line-clamp-1 text-sm font-medium">{r.name}</p>
                    <p className="mt-1 flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                      <Printer className="h-2.5 w-2.5" />
                      {r.epc}
                    </p>
                    {skuCode && (
                      <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                        商品编码：{skuCode}
                      </p>
                    )}
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

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
