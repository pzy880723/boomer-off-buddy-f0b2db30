import { Link } from "@tanstack/react-router";
import { Tags, Boxes, Printer } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CATEGORY_LABEL, formatPrice, type StandardProductGroup, type SkuRow } from "@/lib/inventory.helpers";

/** 标准商品卡：聚合多价格档 */
export function StandardProductCard({ group }: { group: StandardProductGroup }) {
  const visibleTiers = group.tiers.slice(0, 3);
  const remaining = group.tiers.length - visibleTiers.length;
  return (
    <Link
      to="/inventory/products/$code"
      params={{ code: encodeURIComponent(group.key) }}
      className="block"
    >
      <Card className="group h-full overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-card-hover">
        <div className="relative aspect-square overflow-hidden bg-muted">
          {group.image_url ? (
            <img
              src={group.image_url}
              alt={group.name}
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              <Tags className="h-10 w-10" />
            </div>
          )}
          <div className="absolute left-2 top-2 flex flex-wrap gap-1">
            {visibleTiers.map((t) => (
              <Badge key={t} className="bg-primary/90 text-primary-foreground">
                {formatPrice(t)}
              </Badge>
            ))}
            {remaining > 0 && <Badge variant="secondary">+{remaining}</Badge>}
          </div>
          <div className="absolute right-2 top-2">
            <Badge variant="outline" className="bg-background/80 backdrop-blur">
              库存 {group.totalStock}
            </Badge>
          </div>
        </div>
        <div className="p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {CATEGORY_LABEL[group.category] ?? group.category} · 标准
          </p>
          <p className="mt-1 line-clamp-1 text-sm font-medium">{group.name}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {group.tiers.length} 个价格档
            {group.code && <span className="ml-1 font-mono">· {group.code}</span>}
          </p>
        </div>
      </Card>
    </Link>
  );
}

/** 自定义 / 组包 SKU 卡：保留原"一 SKU 一卡"展示 */
export function SingleSkuCard({ row }: { row: SkuRow }) {
  const isBundle = row.kind === "bundle";
  const bundleItems = Array.isArray(row.bundle_items) ? row.bundle_items : [];
  return (
    <Link to="/inventory/skus/$id" params={{ id: row.id }} className="block">
      <Card className="group h-full overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-card-hover">
        <div className="relative aspect-square overflow-hidden bg-muted">
          {row.image_url ? (
            <img
              src={row.image_url}
              alt={row.name}
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              <Tags className="h-10 w-10" />
            </div>
          )}
          <div className="absolute left-2 top-2 flex flex-wrap gap-1">
            <Badge className="bg-primary/90 text-primary-foreground">{formatPrice(row.price_tier)}</Badge>
            {isBundle ? (
              <Badge variant="secondary">
                <Boxes className="mr-0.5 h-2.5 w-2.5" />
                组包·{bundleItems.length}
              </Badge>
            ) : (
              <Badge variant="outline" className="bg-background/80 backdrop-blur">自定义价</Badge>
            )}
          </div>
          <div className="absolute right-2 top-2">
            <Badge variant="outline" className="bg-background/80 backdrop-blur">
              库存 {row.stock_qty}
            </Badge>
          </div>
        </div>
        <div className="p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {CATEGORY_LABEL[row.category] ?? row.category} · {isBundle ? "组包" : "自定义"}
          </p>
          <p className="mt-1 line-clamp-1 text-sm font-medium">{row.name}</p>
          <p className="mt-1 flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
            <Printer className="h-2.5 w-2.5" />
            {row.epc}
          </p>
          {row.sku_code && (
            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">编码：{row.sku_code}</p>
          )}
        </div>
      </Card>
    </Link>
  );
}
