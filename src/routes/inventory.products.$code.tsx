import { useMemo } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Tags, Printer, Package2, ChevronRight, Plus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { listSkus } from "@/lib/inventory.functions";
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
  const decoded = code;
  const nav = useNavigate();
  const listFn = useServerFn(listSkus);

  // 复用同一份 SKU 缓存（与列表页 key 一致以命中缓存）
  const q = useQuery({
    queryKey: ["inv-skus", ""],
    queryFn: () => listFn({ data: { limit: 500 } }),
  });

  const group = useMemo(() => {
    const rows = (q.data?.rows ?? []) as SkuRow[];
    const standards = rows.filter((r) => r.kind === "single" && !r.is_custom_price);
    const groups = groupStandardSkus(standards);
    return groups.find((g) => g.key === decoded) ?? null;
  }, [q.data, decoded]);

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

  return (
    <div className="space-y-4">
      <Link to="/inventory/skus" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary">
        <ArrowLeft className="h-3 w-3" /> 返回 SKU 列表
      </Link>

      <PageHeader
        title={group.name}
        description={`${CATEGORY_LABEL[group.category] ?? group.category} · 标准商品 · ${group.tiers.length} 个价格档`}
        meta={
          <>
            <Badge variant="outline">总库存 {group.totalStock} 件</Badge>
            {group.code && <span className="font-mono text-[11px]">编码：{group.code}</span>}
            {group.weight_g && <span>单重 {group.weight_g}g</span>}
          </>
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => nav({ to: "/inventory/inbound/new" })}
          >
            <Package2 className="mr-1.5 h-3.5 w-3.5" /> 扫枪入库
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* 左：商品图 + 备注 */}
        <div className="space-y-4">
          <Card className="overflow-hidden">
            <div className="aspect-square bg-muted">
              {group.image_url ? (
                <img src={group.image_url} alt={group.name} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                  <Tags className="h-12 w-12" />
                </div>
              )}
            </div>
          </Card>
          {group.notes && (
            <Card className="p-3">
              <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">备注</p>
              <p className="whitespace-pre-wrap text-xs leading-relaxed">{group.notes}</p>
            </Card>
          )}
        </div>

        {/* 右：价格档列表 */}
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">价格档子 SKU</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                每个价格档独立 EPC、独立库存；点击进入打印 / 入库
              </p>
            </div>
            <Button variant="outline" size="sm" disabled title="即将上线">
              <Plus className="mr-1 h-3.5 w-3.5" /> 新增价格档
            </Button>
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
      </div>
    </div>
  );
}
