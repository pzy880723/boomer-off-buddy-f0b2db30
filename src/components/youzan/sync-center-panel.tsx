import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { RefreshCw, Link2, AlertTriangle, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { EmptyState } from "@/components/empty-state";
import { BindYouzanDialog } from "@/components/youzan/bind-youzan-dialog";
import {
  listSkuLinks,
  listSyncQueue,
  listUnboundLocalSkus,
  reconcileAll,
  repairMismatch,
  retryQueueItem,
} from "@/lib/youzan-sync.functions";

// 用在 /youzan 主页 Tabs 里的「数据同步」面板（去掉了 PageHeader）
export function SyncCenterPanel() {
  const unboundFn = useServerFn(listUnboundLocalSkus);
  const linksFn = useServerFn(listSkuLinks);
  const queueFn = useServerFn(listSyncQueue);
  const reconcileFn = useServerFn(reconcileAll);
  const repairFn = useServerFn(repairMismatch);
  const retryFn = useServerFn(retryQueueItem);

  const unbound = useQuery({
    queryKey: ["yz-unbound"],
    queryFn: () => unboundFn(),
  });
  const mismatches = useQuery({
    queryKey: ["yz-mismatch"],
    queryFn: () => linksFn({ data: { status: "mismatch" } }),
  });
  const errors = useQuery({
    queryKey: ["yz-errors"],
    queryFn: () => linksFn({ data: { status: "error" } }),
  });
  const queue = useQuery({
    queryKey: ["yz-queue"],
    queryFn: () => queueFn({ data: { status: "all", limit: 100 } }),
  });

  const refetchAll = () => {
    unbound.refetch();
    mismatches.refetch();
    errors.refetch();
    queue.refetch();
  };

  const [bindTarget, setBindTarget] = useState<{ id: string; name: string } | null>(null);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          本地商品 ↔ 有赞商品的绑定 / 库存推送状态
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const r = await reconcileFn();
            toast.success(`对账完成：共 ${r.total} 条，差异 ${r.mismatch} 条`);
            refetchAll();
          }}
        >
          <RefreshCw className="mr-1 h-3.5 w-3.5" /> 立即对账
        </Button>
      </div>

      <Tabs defaultValue="unbound">
        <TabsList>
          <TabsTrigger value="unbound">
            未绑定
            <span className="ml-1 text-[10px] text-muted-foreground">
              {unbound.data?.rows.length ?? 0}
            </span>
          </TabsTrigger>
          <TabsTrigger value="mismatch">
            <AlertTriangle className="mr-1 h-3 w-3" />
            库存不一致
            <span className="ml-1 text-[10px] text-muted-foreground">
              {mismatches.data?.rows.length ?? 0}
            </span>
          </TabsTrigger>
          <TabsTrigger value="error">
            推送失败
            <span className="ml-1 text-[10px] text-muted-foreground">
              {errors.data?.rows.length ?? 0}
            </span>
          </TabsTrigger>
          <TabsTrigger value="queue">
            <ListChecks className="mr-1 h-3 w-3" />
            推送队列
          </TabsTrigger>
        </TabsList>

        <TabsContent value="unbound" className="mt-3 space-y-2">
          {(unbound.data?.rows ?? []).length === 0 ? (
            <EmptyState icon={Link2} title="所有 SKU 都已绑定" />
          ) : (
            (unbound.data?.rows ?? []).map((s) => (
              <div key={s.id} className="flex items-center gap-3 rounded border p-2">
                <div className="h-10 w-10 overflow-hidden rounded bg-muted">
                  {s.image_url ? (
                    <img src={s.image_url} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 text-sm font-medium">{s.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {s.category} · ¥{s.price_tier} · 库存 {s.stock_qty}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => setBindTarget({ id: s.id, name: s.name })}
                >
                  绑定有赞
                </Button>
              </div>
            ))
          )}
        </TabsContent>

        <TabsContent value="mismatch" className="mt-3 space-y-2">
          {(mismatches.data?.rows ?? []).length === 0 ? (
            <EmptyState icon={AlertTriangle} title="没有不一致的绑定" />
          ) : (
            (mismatches.data?.rows ?? []).map((l) => (
              <div
                key={l.id}
                className="flex items-center gap-3 rounded border p-2 text-sm"
              >
                <Badge variant="destructive">不一致</Badge>
                <span className="font-mono text-xs">SKU {l.sku_id.slice(0, 8)}…</span>
                <span>有赞 item {l.yz_item_id}</span>
                <span className="ml-auto text-muted-foreground">
                  最近推送 {l.last_pushed_stock ?? "—"} / 远端 {l.last_pull_stock ?? "—"}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await repairFn({ data: { sku_id: l.sku_id } });
                    toast.success("已重新推送");
                    refetchAll();
                  }}
                >
                  以本地为准修复
                </Button>
              </div>
            ))
          )}
        </TabsContent>

        <TabsContent value="error" className="mt-3 space-y-2">
          {(errors.data?.rows ?? []).length === 0 ? (
            <EmptyState icon={AlertTriangle} title="没有失败的绑定" />
          ) : (
            (errors.data?.rows ?? []).map((l) => (
              <div
                key={l.id}
                className="space-y-1 rounded border border-destructive/40 p-2 text-sm"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="destructive">失败</Badge>
                  <span className="font-mono text-xs">SKU {l.sku_id.slice(0, 8)}…</span>
                  <span>item {l.yz_item_id}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    onClick={async () => {
                      await repairFn({ data: { sku_id: l.sku_id } });
                      toast.success("已重试");
                      refetchAll();
                    }}
                  >
                    重试
                  </Button>
                </div>
                <p className="text-xs text-destructive">{l.last_error}</p>
              </div>
            ))
          )}
        </TabsContent>

        <TabsContent value="queue" className="mt-3 space-y-2">
          {(queue.data?.rows ?? []).map((t) => (
            <div
              key={t.id}
              className="flex items-center gap-2 rounded border p-2 text-xs"
            >
              <Badge
                variant={
                  t.status === "done"
                    ? "secondary"
                    : t.status === "failed"
                      ? "destructive"
                      : "outline"
                }
              >
                {t.status}
              </Badge>
              <span className="font-mono">{t.sku_id.slice(0, 8)}…</span>
              <span>→ {t.target_stock}</span>
              <span className="text-muted-foreground">{t.reason}</span>
              <span className="ml-auto text-muted-foreground">
                attempts {t.attempts}
              </span>
              {t.status === "failed" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await retryFn({ data: { id: t.id } });
                    toast.success("已重试");
                    refetchAll();
                  }}
                >
                  重试
                </Button>
              )}
            </div>
          ))}
        </TabsContent>
      </Tabs>

      {bindTarget && (
        <BindYouzanDialog
          open={!!bindTarget}
          onOpenChange={(v) => !v && setBindTarget(null)}
          skuId={bindTarget.id}
          skuName={bindTarget.name}
          onBound={refetchAll}
        />
      )}
    </div>
  );
}
