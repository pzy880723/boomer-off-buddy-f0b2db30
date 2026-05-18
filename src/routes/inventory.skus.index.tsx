import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Search, Tags, Package2, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { SkuFormDialog } from "@/components/inventory/sku-form-dialog";
import { listSkus } from "@/lib/inventory.functions";
import {
  INV_CATEGORIES,
  PRICE_TIERS,
  CATEGORY_LABEL,
  SKU_KIND_LABEL,
  formatPrice,
} from "@/lib/inventory.helpers";

export const Route = createFileRoute("/inventory/skus/")({
  head: () => ({
    meta: [{ title: "商品 SKU · 库存" }, { name: "description", content: "中古杂货 SKU 档案与 RFID 标签" }],
  }),
  component: SkusPage,
});

function SkusPage() {
  const nav = useNavigate();
  const listFn = useServerFn(listSkus);
  const [category, setCategory] = useState<string>("all");
  const [tier, setTier] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [openNew, setOpenNew] = useState(false);

  const q = useQuery({
    queryKey: ["inv-skus", category, tier, search],
    queryFn: () =>
      listFn({
        data: {
          category: category === "all" ? undefined : category,
          price_tier: tier === "all" ? undefined : Number(tier),
          search: search || undefined,
          limit: 300,
        },
      }),
  });

  const rows = q.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="商品 SKU"
        description="按 类目 + 价格档 + 品名 共用 EPC；组包商品作为独立 SKU"
        meta={<span>共 {rows.length} 个 SKU · 在库合计 {rows.reduce((s, r) => s + (r.stock_qty ?? 0), 0)} 件</span>}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => nav({ to: "/inventory/inbound/new" })}>
              <Package2 className="mr-1.5 h-3.5 w-3.5" /> 扫枪入库
            </Button>
            <Button size="sm" className="bg-gradient-brand hover:opacity-90" onClick={() => setOpenNew(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> 新建 SKU
            </Button>
          </>
        }
      />

      <Tabs value={category} onValueChange={setCategory}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="all">全部</TabsTrigger>
          {INV_CATEGORIES.map((c) => (
            <TabsTrigger key={c.value} value={c.value}>
              {c.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={tier} onValueChange={setTier}>
          <TabsList>
            <TabsTrigger value="all">全档</TabsTrigger>
            {PRICE_TIERS.map((t) => (
              <TabsTrigger key={t} value={String(t)}>
                ¥{t}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative ml-auto">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜品名 / EPC"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setSearch(searchInput.trim())}
            className="h-8 w-56 pl-7 text-xs"
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Tags}
          title="还没有 SKU"
          description="点击右上「新建 SKU」创建第一个商品档案"
          action={
            <Button size="sm" onClick={() => setOpenNew(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> 新建 SKU
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {rows.map((r) => (
            <Link
              key={r.id}
              to="/inventory/skus/$id"
              params={{ id: r.id }}
              className="block"
            >
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
                  <div className="absolute left-2 top-2 flex gap-1">
                    <Badge className="bg-primary/90 text-primary-foreground">{formatPrice(r.price_tier)}</Badge>
                    {r.kind === "pack" && (
                      <Badge variant="secondary">组包·{r.pack_pieces ?? "?"}</Badge>
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
                    {CATEGORY_LABEL[r.category] ?? r.category} · {SKU_KIND_LABEL[r.kind as "single" | "pack"]}
                  </p>
                  <p className="mt-1 line-clamp-1 text-sm font-medium">{r.name}</p>
                  <p className="mt-1 flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                    <Printer className="h-2.5 w-2.5" />
                    {r.epc}
                  </p>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <SkuFormDialog open={openNew} onOpenChange={setOpenNew} onCreated={() => q.refetch()} />
    </div>
  );
}
