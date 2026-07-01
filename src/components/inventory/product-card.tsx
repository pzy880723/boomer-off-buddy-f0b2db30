import { Link } from "@tanstack/react-router";
import { Tags, Boxes, Printer, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CATEGORY_LABEL, formatPrice, type StandardProductGroup, type SkuRow } from "@/lib/inventory.helpers";
import { toThumbUrl } from "@/lib/image";

/** 标准商品卡：聚合多价格档 */
export function StandardProductCard({
  group,
  actions,
  coverOverride,
}: {
  group: StandardProductGroup;
  actions?: ReactNode;
  coverOverride?: string | null;
}) {
  const visibleTiers = group.tiers.slice(0, 3);
  const remaining = group.tiers.length - visibleTiers.length;
  const cover = coverOverride ?? group.image_url;
  return (
    <div className="relative">
      <Link to="/inventory/products/$code" params={{ code: group.key }} className="block">
        <Card className="group h-full overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-card-hover">
          <div className="relative aspect-square overflow-hidden bg-muted">
            {cover ? (
              <img
                src={cover}
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
      {actions && (
        <div className="absolute right-2 bottom-2 rounded-md bg-background/90 shadow-sm backdrop-blur">
          {actions}
        </div>
      )}
    </div>
  );
}

/** 自定义 / 组包 SKU 卡：保留原"一 SKU 一卡"展示 */
export function SingleSkuCard({
  row,
  actions,
  coverOverride,
}: {
  row: SkuRow;
  actions?: ReactNode;
  coverOverride?: string | null;
}) {
  const isBundle = row.kind === "bundle";
  const bundleItems = Array.isArray(row.bundle_items) ? row.bundle_items : [];
  const cover = coverOverride ?? row.image_url;
  return (
    <div className="relative">
      <Link to="/inventory/skus/$id" params={{ id: row.id }} className="block">
        <Card className="group h-full overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-card-hover">
          <div className="relative aspect-square overflow-hidden bg-muted">
            {cover ? (
              <img
                src={cover}
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
      {actions && (
        <div className="absolute right-2 bottom-2 rounded-md bg-background/90 shadow-sm backdrop-blur">
          {actions}
        </div>
      )}
    </div>
  );
}

/** 列表行 - 标准商品 */
export function StandardProductRow({
  group,
  actions,
  coverOverride,
}: {
  group: StandardProductGroup;
  actions?: ReactNode;
  coverOverride?: string | null;
}) {
  const visibleTiers = group.tiers.slice(0, 4);
  const remaining = group.tiers.length - visibleTiers.length;
  const cover = coverOverride ?? group.image_url;
  return (
    <div className="flex items-center gap-3 border-b px-3 py-2.5 transition-colors last:border-b-0 hover:bg-muted/60">
      <Link
        to="/inventory/products/$code"
        params={{ code: group.key }}
        className="flex flex-1 items-center gap-3"
      >
        <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded bg-muted">
          {cover ? (
            <img src={cover} alt={group.name} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              <Tags className="h-5 w-5" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{group.name}</span>
            <Badge variant="outline" className="text-[10px]">标准</Badge>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {CATEGORY_LABEL[group.category] ?? group.category}
            {group.code && <span className="ml-2 font-mono">{group.code}</span>}
          </p>
        </div>
        <div className="hidden flex-wrap items-center justify-end gap-1 sm:flex">
          {visibleTiers.map((t) => (
            <Badge key={t} className="bg-primary/90 text-primary-foreground tabular-nums">
              {formatPrice(t)}
            </Badge>
          ))}
          {remaining > 0 && <Badge variant="secondary">+{remaining}</Badge>}
        </div>
        <div className="w-20 text-right text-xs tabular-nums">
          库存 <span className="font-semibold">{group.totalStock}</span>
        </div>
        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      </Link>
      {actions}
    </div>
  );
}

/** 列表行 - 自定义/组包 SKU */
export function SingleSkuRow({
  row,
  actions,
  coverOverride,
}: {
  row: SkuRow;
  actions?: ReactNode;
  coverOverride?: string | null;
}) {
  const isBundle = row.kind === "bundle";
  const bundleItems = Array.isArray(row.bundle_items) ? row.bundle_items : [];
  const cover = coverOverride ?? row.image_url;
  return (
    <div className="flex items-center gap-3 border-b px-3 py-2.5 transition-colors last:border-b-0 hover:bg-muted/60">
      <Link
        to="/inventory/skus/$id"
        params={{ id: row.id }}
        className="flex flex-1 items-center gap-3"
      >
        <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded bg-muted">
          {cover ? (
            <img src={cover} alt={row.name} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              <Tags className="h-5 w-5" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{row.name}</span>
            {isBundle ? (
              <Badge variant="secondary" className="text-[10px]">
                <Boxes className="mr-0.5 h-2.5 w-2.5" />组包·{bundleItems.length}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">自定义</Badge>
            )}
          </div>
          <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
            {CATEGORY_LABEL[row.category] ?? row.category}
            <span className="mx-1">·</span>
            <Printer className="h-2.5 w-2.5" />
            <span className="font-mono">{row.epc}</span>
          </p>
        </div>
        <Badge className="bg-primary/90 text-primary-foreground tabular-nums">{formatPrice(row.price_tier)}</Badge>
        <div className="w-20 text-right text-xs tabular-nums">
          库存 <span className="font-semibold">{row.stock_qty}</span>
        </div>
        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      </Link>
      {actions}
    </div>
  );
}
