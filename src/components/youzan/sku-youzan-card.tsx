import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Link2,
  Link2Off,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  getSkuLink,
  unlinkSku,
  repairMismatch,
} from "@/lib/youzan-sync.functions";
import { BindYouzanDialog } from "./bind-youzan-dialog";

export function SkuYouzanCard({
  skuId,
  skuName,
}: {
  skuId: string;
  skuName?: string;
}) {
  const getFn = useServerFn(getSkuLink);
  const unlinkFn = useServerFn(unlinkSku);
  const repairFn = useServerFn(repairMismatch);
  const [openBind, setOpenBind] = useState(false);

  const q = useQuery({
    queryKey: ["sku-youzan-link", skuId],
    queryFn: () => getFn({ data: { sku_id: skuId } }),
  });

  const unlinkMut = useMutation({
    mutationFn: () => unlinkFn({ data: { sku_id: skuId } }),
    onSuccess: () => {
      toast.success("已解绑");
      q.refetch();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const repairMut = useMutation({
    mutationFn: () => repairFn({ data: { sku_id: skuId } }),
    onSuccess: () => {
      toast.success("已触发以本地库存为准的重推");
      setTimeout(() => q.refetch(), 800);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (q.isLoading) {
    return (
      <Card className="p-4 text-sm text-muted-foreground">加载有赞绑定状态…</Card>
    );
  }

  const link = q.data?.link;
  const recent = q.data?.recent ?? [];

  if (!link) {
    return (
      <>
        <Card className="flex items-center justify-between gap-3 p-4">
          <div>
            <p className="text-sm font-semibold">有赞同步</p>
            <p className="text-xs text-muted-foreground">
              未绑定有赞商品，库存变化不会推送
            </p>
          </div>
          <Button size="sm" onClick={() => setOpenBind(true)}>
            <Link2 className="mr-1.5 h-3.5 w-3.5" />
            绑定有赞商品
          </Button>
        </Card>
        <BindYouzanDialog
          open={openBind}
          onOpenChange={setOpenBind}
          skuId={skuId}
          skuName={skuName}
          onBound={() => q.refetch()}
        />
      </>
    );
  }

  const statusBadge =
    link.status === "linked" ? (
      <Badge className="bg-success/15 text-success hover:bg-success/15">
        <CheckCircle2 className="mr-1 h-3 w-3" />已同步
      </Badge>
    ) : link.status === "mismatch" ? (
      <Badge variant="outline" className="border-amber-500 text-amber-600">
        <AlertTriangle className="mr-1 h-3 w-3" />库存不一致
      </Badge>
    ) : (
      <Badge variant="destructive">
        <AlertTriangle className="mr-1 h-3 w-3" />同步错误
      </Badge>
    );

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">有赞同步</p>
            {statusBadge}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            item_id <span className="font-mono">{link.yz_item_id}</span>
            {link.yz_sku_id ? (
              <>
                {" "}
                · sku_id <span className="font-mono">{link.yz_sku_id}</span>
              </>
            ) : null}
          </p>
          {link.last_pushed_at && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              最近推送 {new Date(link.last_pushed_at).toLocaleString("zh-CN")} ·
              数量 {link.last_pushed_stock}
            </p>
          )}
          {link.last_pull_at && (
            <p className="text-xs text-muted-foreground">
              最近对账 {new Date(link.last_pull_at).toLocaleString("zh-CN")} ·
              有赞库存 {link.last_pull_stock}
            </p>
          )}
          {link.last_error && (
            <p className="mt-1 line-clamp-2 text-xs text-destructive">
              {link.last_error}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={repairMut.isPending}
            onClick={() => repairMut.mutate()}
          >
            {repairMut.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
            )}
            立即重推
          </Button>
          <a
            href={`https://www.youzan.com/v4/goods/manage?item_id=${link.yz_item_id}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center text-[11px] text-muted-foreground hover:text-primary"
          >
            打开有赞商品页 <ExternalLink className="ml-1 h-3 w-3" />
          </a>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={unlinkMut.isPending}
            onClick={() => unlinkMut.mutate()}
          >
            <Link2Off className="mr-1 h-3.5 w-3.5" />
            解绑
          </Button>
        </div>
      </div>

      {recent.length > 0 && (
        <div className="rounded border bg-muted/40 p-2">
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">
            最近 {recent.length} 次同步
          </p>
          <ul className="space-y-0.5 text-[11px]">
            {recent.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">
                  {new Date(r.created_at).toLocaleString("zh-CN")} · {r.reason}
                </span>
                <span className="flex items-center gap-1">
                  <span className="tabular-nums">→ {r.target_stock}</span>
                  <Badge
                    variant="outline"
                    className={
                      r.status === "done"
                        ? "border-success text-success"
                        : r.status === "failed"
                          ? "border-destructive text-destructive"
                          : ""
                    }
                  >
                    {r.status}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
