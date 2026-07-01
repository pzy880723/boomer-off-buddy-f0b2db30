import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import { listShopHealth } from "@/lib/youzan-sync.functions";

export function ShopHealthPanel() {
  const fn = useServerFn(listShopHealth);
  const q = useQuery({ queryKey: ["yz-shop-health"], queryFn: () => fn() });

  const shops = q.data?.shops ?? [];
  const orphans = q.data?.orphan_shop_locations ?? [];
  const hasIssues =
    shops.some((s) => s.issues.length > 0) || orphans.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          门店 · 库位绑定 · 库存模式健康检查
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
        >
          <RefreshCw
            className={`mr-1 h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`}
          />
          刷新
        </Button>
      </div>

      {!hasIssues && shops.length > 0 && (
        <div className="flex items-center gap-2 rounded border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4" />
          所有门店配置正常
        </div>
      )}

      {orphans.length > 0 && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          <div className="mb-1 flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            {orphans.length} 个库位（kind=shop）未绑定有赞门店
          </div>
          <div className="flex flex-wrap gap-1">
            {orphans.map((o) => (
              <Badge key={o.id} variant="outline" className="text-[10px]">
                {o.name}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {shops.length === 0 ? (
        <EmptyState icon={AlertTriangle} title="尚未配置有赞门店" />
      ) : (
        <div className="space-y-2">
          {shops.map((s) => (
            <div
              key={s.id}
              className={`rounded border p-3 text-sm ${
                s.issues.length > 0
                  ? "border-amber-500/40 bg-amber-500/5"
                  : "border-border"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.shop_name}</span>
                <Badge
                  variant={s.role === "hq" ? "default" : "secondary"}
                  className="text-[10px]"
                >
                  {s.role === "hq" ? "总部" : "分店"}
                </Badge>
                <Badge variant="outline" className="text-[10px] font-mono">
                  kdt {s.kdt_id}
                </Badge>
                {s.role === "branch" && (
                  <Badge
                    variant={s.parent_kdt_id ? "outline" : "destructive"}
                    className="text-[10px] font-mono"
                  >
                    parent {s.parent_kdt_id ?? "缺失"}
                  </Badge>
                )}
                <Badge
                  variant="outline"
                  className={`text-[10px] ${
                    s.stock_mode === "master_spu"
                      ? "border-sky-500/40 text-sky-700 dark:text-sky-300"
                      : "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                  }`}
                >
                  {s.stock_mode === "master_spu"
                    ? "SPU 主库（不推库存）"
                    : "独立库存"}
                </Badge>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  绑定 {s.link_count} · 参与推送 {s.stock_sync_count}
                </span>
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">
                关联库位：{" "}
                {s.bound_location ? (
                  <span className="text-foreground">
                    {s.bound_location.name}（{s.bound_location.kind}）
                  </span>
                ) : (
                  <span className="text-amber-700 dark:text-amber-300">
                    未绑定
                  </span>
                )}
              </div>
              {s.issues.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {s.issues.map((it, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-300"
                    >
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      {it}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
